/**
 * Integration test harness — manually fires one indexDocument Temporal workflow.
 *
 * Usage:
 *   DATASET_ID=economic-census \
 *   DOCUMENT_TEXT="King County, WA had a median household income of $93,000 in 2021..." \
 *   SOURCE_URL="https://example.com/census-report-2021" \
 *   npx ts-node src/scripts/triggerDocument.ts
 *
 * OCR flow for PDF:
 *   DATASET_ID=economic-census \
 *   SOURCE_URL="https://example.com/report.pdf" \
 *   SOURCE_PATH="/absolute/path/to/report.pdf" \
 *   npx ts-node src/scripts/triggerDocument.ts
 */

import { getDataset } from "../config/manifest";
import { buildDeterministicIdentity } from "../utils/pipelineIdentity";
import { DEFAULT_TRIGGER_DOCUMENT_TEXT } from "../constants/pipeline";
import type { IndexDocumentInput } from "../workflows/indexDocument";
import {
  connectTemporal,
  getTaskQueue,
  startIndexDocumentWorkflow,
} from "./lib/indexingWorkflow";

async function main() {
  const datasetId = process.env.DATASET_ID ?? "economic-census";
  const sourceUrl = process.env.SOURCE_URL ?? "https://example.com/test-document";
  const sourcePath = process.env.SOURCE_PATH;
  const externalDocumentId = process.env.DOCUMENT_EXTERNAL_ID;
  const shouldPreferOcr = (sourcePath ?? sourceUrl).toLowerCase().endsWith(".pdf");
  const text =
    process.env.DOCUMENT_TEXT ??
    (shouldPreferOcr ? undefined : DEFAULT_TRIGGER_DOCUMENT_TEXT);
  const taskQueue = getTaskQueue();

  const dataset = getDataset(datasetId);
  console.log(`Dataset: ${dataset.label} (${datasetId})`);

  const deterministic = buildDeterministicIdentity({
    datasetId,
    sourceUrl,
    sourcePath,
    externalDocumentId,
  });
  console.log(`Document IRI: ${deterministic.documentIri}`);
  console.log(`Document key: ${deterministic.documentKey}`);
  console.log(`Source URL:   ${sourceUrl}`);
  if (sourcePath) console.log(`Source path:  ${sourcePath}`);
  if (text) console.log(`Text length:  ${text.length} chars`);

  const { connection, client } = await connectTemporal();
  const workflowId = deterministic.workflowId;
  const input: IndexDocumentInput = {
    datasetId,
    documentKey: deterministic.documentKey,
    documentIri: deterministic.documentIri,
    text,
    sourceUrl,
    sourcePath,
  };

  console.log(`\nStarting workflow: ${workflowId}`);

  const initialAttempt = await startIndexDocumentWorkflow({
    client,
    taskQueue,
    workflowId,
    input,
  });

  let handle = initialAttempt.handle;
  if (initialAttempt.skippedBecauseRunning || !handle) {
    console.log(`Workflow already running for ${workflowId}. Terminating existing run and restarting...`);
    const existing = client.workflow.getHandle(workflowId);
    await existing.terminate("restart requested for deterministic document workflow");

    const restarted = await startIndexDocumentWorkflow({
      client,
      taskQueue,
      workflowId,
      input,
    });

    if (!restarted.handle) {
      throw new Error(`Failed to restart workflow ${workflowId} after terminating existing run.`);
    }

    handle = restarted.handle;
  }

  console.log("Workflow started. Waiting for completion...");
  console.log(`Temporal UI: http://localhost:8088/namespaces/default/workflows/${workflowId}`);

  await handle.result();
  console.log("\nWorkflow complete.");
  console.log(`Entity page: http://localhost:4321/dataset/${datasetId}`);

  await connection.close();
}

main().catch((error) => {
  console.error("triggerDocument failed:", error);
  process.exit(1);
});
