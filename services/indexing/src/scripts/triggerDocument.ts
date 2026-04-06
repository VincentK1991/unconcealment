/**
 * Integration test harness — manually fires one indexDocument Temporal workflow.
 *
 * Usage:
 *   DATASET_ID=economic-census \
 *   DOCUMENT_TEXT="King County, WA had a median household income of $93,000 in 2021..." \
 *   SOURCE_URL="https://example.com/census-report-2021" \
 *   npx ts-node src/scripts/triggerDocument.ts
 *
 * Or edit the defaults below and run directly.
 *
 * Requires:
 *   - Temporal server running at TEMPORAL_ADDRESS (default: localhost:7233)
 *   - indexing worker running (npm run worker)
 *   - Java backend running at BACKEND_URL (default: http://localhost:8080)
 *   - Fuseki running at http://localhost:3030
 */

import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "crypto";
import { getBaseUri, getDataset } from "../config/manifest";
import type { IndexDocumentInput } from "../workflows/indexDocument";

async function main() {
  const datasetId   = process.env.DATASET_ID   ?? "economic-census";
  const sourceUrl   = process.env.SOURCE_URL   ?? "https://example.com/test-document";
  const text        = process.env.DOCUMENT_TEXT ?? DEFAULT_TEST_TEXT;
  const taskQueue   = process.env.TEMPORAL_TASK_QUEUE ?? "unconcealment-indexing";

  // Validate dataset exists in manifest
  const dataset = getDataset(datasetId);
  console.log(`Dataset: ${dataset.label} (${datasetId})`);

  // Mint a document IRI using the manifest's documentSegment
  const documentUuid = randomUUID();
  const baseUri = getBaseUri(datasetId);
  const documentIri = `${baseUri}/document/${documentUuid}`;
  console.log(`Document IRI: ${documentIri}`);
  console.log(`Source URL:   ${sourceUrl}`);
  console.log(`Text length:  ${text.length} chars`);

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  const client = new Client({ connection });

  const workflowId = `index-doc-${documentUuid}`;
  const input: IndexDocumentInput = { datasetId, documentIri, text, sourceUrl };

  console.log(`\nStarting workflow: ${workflowId}`);

  const handle = await client.workflow.start("indexDocument", {
    taskQueue,
    workflowId,
    args: [input],
  });

  console.log(`Workflow started. Waiting for completion...`);
  console.log(`Temporal UI: http://localhost:8088/namespaces/default/workflows/${workflowId}`);

  await handle.result();
  console.log(`\nWorkflow complete.`);
  console.log(`Entity page: http://localhost:4321/dataset/${datasetId}`);

  await connection.close();
}

const DEFAULT_TEST_TEXT = `
King County, Washington is the most populous county in Washington State and the 13th-most
populous county in the United States. As of the 2020 Census, the population was 2,269,675.
The county seat is Seattle. King County had a median household income of approximately
$93,000 in 2021 according to the American Community Survey. The unemployment rate was
3.2% in the same period. The county includes parts of the Seattle metropolitan area,
encompassing cities such as Bellevue, Redmond, and Kirkland.
The FIPS code for King County is 53033.
`.trim();

main().catch((err) => {
  console.error("triggerDocument failed:", err);
  process.exit(1);
});
