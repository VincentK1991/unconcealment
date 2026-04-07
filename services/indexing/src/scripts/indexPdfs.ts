import { promises as fs } from "fs";
import path from "path";
import { getDataset } from "../config/manifest";
import { buildDeterministicIdentity } from "../utils/pipelineIdentity";
import type { IndexDocumentInput } from "../workflows/indexDocument";
import {
  connectTemporal,
  getTaskQueue,
  startIndexDocumentWorkflow,
} from "./lib/indexingWorkflow";

interface CliOptions {
  inputPath: string;
  datasetId?: string;
  maxInFlight: number;
  limit?: number;
  dryRun: boolean;
  continueOnError: boolean;
}

interface PendingDocument {
  datasetId: string;
  sourcePath: string;
  sourceUrl: string;
  input: IndexDocumentInput;
  workflowId: string;
  documentIri: string;
}

interface RunStats {
  discovered: number;
  started: number;
  skipped: number;
  completed: number;
  failed: number;
}

type DocumentRunResult = "completed" | "skipped";

const REPO_ROOT = path.resolve(__dirname, "../../../../");
const DATA_ROOT = path.join(REPO_ROOT, "data");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const documents = await discoverDocuments(options);

  if (documents.length === 0) {
    console.log("No PDF files found.");
    return;
  }

  console.log(`Discovered ${documents.length} PDF file(s).`);
  console.log(`Max in-flight workflows: ${options.maxInFlight}`);
  if (options.limit !== undefined) {
    console.log(`Limit: ${options.limit}`);
  }

  if (options.dryRun) {
    for (const document of documents) {
      console.log(
        `[dry-run] dataset=${document.datasetId} workflowId=${document.workflowId} sourcePath=${document.sourcePath}`
      );
    }
    return;
  }

  const { connection, client } = await connectTemporal();
  const taskQueue = getTaskQueue();
  const stats: RunStats = {
    discovered: documents.length,
    started: 0,
    skipped: 0,
    completed: 0,
    failed: 0,
  };

  try {
    await runWithBackpressure({
      documents,
      maxInFlight: options.maxInFlight,
      continueOnError: options.continueOnError,
      onDocumentFailed() {
        stats.failed += 1;
      },
      startDocument: async (document) => {
        const result = await startIndexDocumentWorkflow({
          client,
          taskQueue,
          workflowId: document.workflowId,
          input: document.input,
        });

        if (result.skippedBecauseRunning || !result.handle) {
          stats.skipped += 1;
          console.log(
            `[skip] workflow already running dataset=${document.datasetId} workflowId=${document.workflowId}`
          );
          return "skipped";
        }

        stats.started += 1;
        console.log(
          `[start] dataset=${document.datasetId} workflowId=${document.workflowId} sourcePath=${document.sourcePath}`
        );
        await result.handle.result();
        console.log(
          `[done] dataset=${document.datasetId} workflowId=${document.workflowId}`
        );
        return "completed";
      },
      onDocumentFinished(result) {
        if (result === "completed") {
          stats.completed += 1;
        }
      },
    });
  } finally {
    await connection.close();
  }

  console.log("");
  console.log("Summary");
  console.log(`Discovered: ${stats.discovered}`);
  console.log(`Started:    ${stats.started}`);
  console.log(`Skipped:    ${stats.skipped}`);
  console.log(`Completed:  ${stats.completed}`);
  console.log(`Failed:     ${stats.failed}`);
}

async function runWithBackpressure(input: {
  documents: PendingDocument[];
  maxInFlight: number;
  continueOnError: boolean;
  startDocument: (document: PendingDocument) => Promise<DocumentRunResult>;
  onDocumentFinished: (result: DocumentRunResult) => void;
  onDocumentFailed: () => void;
}): Promise<void> {
  const queue = [...input.documents];
  const inFlight = new Set<Promise<void>>();
  let firstError: unknown;

  const launchNext = (): void => {
    while (queue.length > 0 && inFlight.size < input.maxInFlight) {
      const document = queue.shift();
      if (!document) {
        return;
      }

      const run = (async () => {
        try {
          const result = await input.startDocument(document);
          input.onDocumentFinished(result);
        } catch (error) {
          input.onDocumentFailed();
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[fail] dataset=${document.datasetId} workflowId=${document.workflowId} sourcePath=${document.sourcePath} error=${message}`
          );

          if (!input.continueOnError && firstError === undefined) {
            firstError = error;
          }
        }
      })();

      inFlight.add(run);
      run.finally(() => {
        inFlight.delete(run);
      });
    }
  };

  launchNext();

  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    if (firstError !== undefined) {
      await Promise.allSettled(inFlight);
      throw firstError;
    }
    launchNext();
  }
}

async function discoverDocuments(options: CliOptions): Promise<PendingDocument[]> {
  const absoluteInput = path.resolve(options.inputPath);
  const stat = await fs.stat(absoluteInput);
  const sourcePaths = stat.isDirectory()
    ? await collectPdfFiles(absoluteInput)
    : [absoluteInput];

  const documents: PendingDocument[] = [];
  for (const sourcePath of sourcePaths) {
    if (!isPdfPath(sourcePath)) {
      continue;
    }

    const datasetId = options.datasetId ?? inferDatasetIdFromPath(sourcePath);
    getDataset(datasetId);

    const sourceUrl = buildFileSourceUrl(sourcePath);
    const deterministic = buildDeterministicIdentity({
      datasetId,
      sourcePath,
      sourceUrl,
    });

    documents.push({
      datasetId,
      sourcePath,
      sourceUrl,
      workflowId: deterministic.workflowId,
      documentIri: deterministic.documentIri,
      input: {
        datasetId,
        documentKey: deterministic.documentKey,
        documentIri: deterministic.documentIri,
        sourceUrl,
        sourcePath,
      },
    });
  }

  documents.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  if (options.limit !== undefined) {
    return documents.slice(0, options.limit);
  }
  return documents;
}

async function collectPdfFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectPdfFiles(entryPath);
      }
      return isPdfPath(entryPath) ? [entryPath] : [];
    })
  );

  return files.flat();
}

function inferDatasetIdFromPath(sourcePath: string): string {
  const relativeToData = path.relative(DATA_ROOT, sourcePath);
  if (
    relativeToData.startsWith("..") ||
    path.isAbsolute(relativeToData) ||
    relativeToData === ""
  ) {
    throw new Error(
      `Cannot infer dataset from path outside data directory: ${sourcePath}. Use --dataset.`
    );
  }

  const [datasetId] = relativeToData.split(path.sep);
  if (!datasetId) {
    throw new Error(
      `Cannot infer dataset from path: ${sourcePath}. Use --dataset.`
    );
  }

  return datasetId;
}

function buildFileSourceUrl(sourcePath: string): string {
  const normalized = sourcePath.split(path.sep).join("/");
  return `file://${normalized}`;
}

function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

function parseArgs(argv: string[]): CliOptions {
  let inputPath: string | undefined;
  let datasetId: string | undefined;
  let maxInFlight = 2;
  let limit: number | undefined;
  let dryRun = false;
  let continueOnError = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dataset") {
      datasetId = requireValue(arg, argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--max-in-flight") {
      const raw = requireValue(arg, argv[index + 1]);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--max-in-flight must be a positive integer. Received: ${raw}`);
      }
      maxInFlight = parsed;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const raw = requireValue(arg, argv[index + 1]);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--limit must be a positive integer. Received: ${raw}`);
      }
      limit = parsed;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--continue-on-error") {
      continueOnError = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsageAndExit();
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (inputPath) {
      throw new Error(`Unexpected extra positional argument: ${arg}`);
    }

    inputPath = arg;
  }

  if (!inputPath) {
    printUsageAndExit("Input path is required.");
  }

  return {
    inputPath,
    datasetId,
    maxInFlight,
    limit,
    dryRun,
    continueOnError,
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsageAndExit(errorMessage?: string): never {
  if (errorMessage) {
    console.error(errorMessage);
    console.error("");
  }

  console.error("Usage:");
  console.error(
    "  npx ts-node src/scripts/indexPdfs.ts <path> [--dataset <dataset-id>] [--max-in-flight <n>] [--limit <n>] [--dry-run] [--continue-on-error]"
  );
  console.error("");
  console.error("Examples:");
  console.error(
    "  npx ts-node src/scripts/indexPdfs.ts ../../data/economic-census --max-in-flight 2 --limit 2"
  );
  console.error(
    "  npx ts-node src/scripts/indexPdfs.ts ../../data/public-health/nhsr144-508.pdf"
  );
  process.exit(errorMessage ? 1 : 0);
}

main().catch((error) => {
  console.error("indexPdfs failed:", error);
  process.exit(1);
});
