import { createHash } from "crypto";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getDataset } from "../config/manifest";
import { buildDeterministicIdentity } from "../utils/pipelineIdentity";
import type { CleanupDocumentInput } from "../workflows/cleanupDocument";

function buildCleanupWorkflowId(datasetId: string, documentIri: string, fallbackKey: string): string {
  const suffix = fallbackKey || createHash("sha256").update(`${datasetId}|${documentIri}`).digest("hex").slice(0, 16);
  return `cleanup-doc-${datasetId}-${suffix}`;
}

async function main() {
  const datasetId = process.env.DATASET_ID ?? "economic-census";
  const sourceUrl = process.env.SOURCE_URL ?? "https://example.com/test-document";
  const sourcePath = process.env.SOURCE_PATH;
  const externalDocumentId = process.env.DOCUMENT_EXTERNAL_ID;
  const explicitDocumentIri = process.env.DOCUMENT_IRI;
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "unconcealment-indexing";

  const dataset = getDataset(datasetId);
  console.log(`Dataset: ${dataset.label} (${datasetId})`);

  const deterministic = buildDeterministicIdentity({
    datasetId,
    sourceUrl,
    sourcePath,
    externalDocumentId,
  });
  const documentIri = explicitDocumentIri ?? deterministic.documentIri;
  const workflowId = buildCleanupWorkflowId(datasetId, documentIri, deterministic.documentKey);

  console.log(`Document IRI: ${documentIri}`);
  console.log(`Cleanup workflow: ${workflowId}`);

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const client = new Client({ connection });

  const input: CleanupDocumentInput = {
    datasetId,
    documentIri,
  };

  let handle;
  try {
    handle = await client.workflow.start("cleanupDocument", {
      taskQueue,
      workflowId,
      args: [input],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      throw error;
    }

    console.log(`Workflow already running for ${workflowId}. Terminating existing run and restarting...`);
    const existing = client.workflow.getHandle(workflowId);
    await existing.terminate("restart requested for deterministic cleanup workflow");
    handle = await client.workflow.start("cleanupDocument", {
      taskQueue,
      workflowId,
      args: [input],
    });
  }

  console.log("Cleanup workflow started. Waiting for completion...");
  console.log(`Temporal UI: http://localhost:8088/namespaces/default/workflows/${workflowId}`);

  await handle.result();
  console.log("Cleanup complete.");

  await connection.close();
}

main().catch((error) => {
  console.error("cleanupDocument failed:", error);
  process.exit(1);
});
