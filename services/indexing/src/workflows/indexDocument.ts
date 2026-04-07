import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PIPELINE_CONSTANTS } from "../constants/pipeline";

// ─── Retry policy shared across all activity groups ────────────────────────
// Use numeric millisecond values so TypeScript resolves them as Duration correctly.
const baseRetry = {
  initialInterval:    PIPELINE_CONSTANTS.retry.initialIntervalMs,
  backoffCoefficient: PIPELINE_CONSTANTS.retry.backoffCoefficient,
  maximumInterval:    PIPELINE_CONSTANTS.retry.maximumIntervalMs,
  maximumAttempts:    PIPELINE_CONSTANTS.retry.maximumAttempts,
} as const;

// ─── Fast activities: simple HTTP/storage calls, expected < 2 min ─────────
const {
  uploadSourceDocument,
  deleteSourceDocument,
  assertToGraph,
  deleteGraphAssertions,
  restoreGraphAssertions,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout:    "45 seconds",
  retry: {
    ...baseRetry,
    nonRetryableErrorTypes: [
      "NonRetryableDocumentInputError",
      "NonRetryableGraphAssertionError",
    ],
  },
});

// ─── Resolve: OCR via liteparse can be slow on large PDFs ─────────────────
const { resolveDocumentContent } = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout:    "2 minutes",
  retry: {
    ...baseRetry,
    nonRetryableErrorTypes: ["NonRetryableDocumentInputError"],
  },
});

// ─── Embed: batched OpenAI calls + DB write; heartbeats per batch ──────────
const {
  embedAndStore,
  deleteDocumentEmbeddings,
  restoreDocumentEmbeddings,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout:    "3 minutes",
  retry: {
    ...baseRetry,
    maximumAttempts: 3, // fewer retries: each attempt can be 30+ min
  },
});

// ─── Extract: single LLM call that can run several minutes for large docs ──
const { extractEntities } = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout:    "10 minutes", // must exceed the longest expected LLM response time
  retry: {
    ...baseRetry,
    nonRetryableErrorTypes: ["NonRetryableExtractionSchemaError"],
  },
});

// ───────────────────────────────────────────────────────────────────────────

export interface IndexDocumentInput {
  datasetId: string;
  documentKey: string;
  documentIri: string;
  text?: string;
  sourceUrl: string;
  sourcePath?: string;
}

export async function indexDocument(input: IndexDocumentInput): Promise<void> {
  const wf = workflowInfo();
  const indexingRunId = `${wf.workflowId}:${wf.runId}`;

  let uploaded: Awaited<ReturnType<typeof uploadSourceDocument>> | undefined;
  let snapshotBucket: string | null = null;
  let snapshotObjectKey: string | null = null;
  let documentStored = false;
  let graphStored = false;

  try {
    uploaded = await uploadSourceDocument({
      datasetId:   input.datasetId,
      documentKey: input.documentKey,
      sourceUrl:   input.sourceUrl,
      sourcePath:  input.sourcePath,
      text:        input.text,
    });

    const resolved = await resolveDocumentContent({
      bucket:    uploaded.bucket,
      objectKey: uploaded.objectKey,
      mimeType:  uploaded.mimeType,
    });

    const stored = await embedAndStore({
      datasetId:        input.datasetId,
      documentIri:      input.documentIri,
      textBucket:       resolved.textBucket,
      textObjectKey:    resolved.textObjectKey,
      sourceUrl:        input.sourceUrl,
      contentHash:      resolved.contentHash,
      mimeType:         resolved.mimeType,
      ocrEngine:        resolved.ocrEngine,
      storageBucket:    uploaded.bucket,
      storageObjectKey: uploaded.objectKey,
      storagePath:      uploaded.storagePath,
    });
    snapshotBucket    = stored.snapshotBucket;
    snapshotObjectKey = stored.snapshotObjectKey;
    documentStored    = true;

    const { entities, relationships } = await extractEntities({
      datasetId:      input.datasetId,
      documentIri:    input.documentIri,
      textBucket:     resolved.textBucket,
      textObjectKey:  resolved.textObjectKey,
      chunkIds:       stored.chunkIds,
    });

    await assertToGraph({
      datasetId:     input.datasetId,
      documentIri:   input.documentIri,
      indexingRunId,
      entities,
      relationships,
    });
    graphStored = true;
  } catch (error) {
    // ── Compensation (best-effort rollback) ────────────────────────────────
    try {
      if (graphStored) {
        await deleteGraphAssertions({
          datasetId:   input.datasetId,
          documentIri: input.documentIri,
        });
      }

      if (documentStored) {
        if (snapshotBucket && snapshotObjectKey) {
          await restoreDocumentEmbeddings({ snapshotBucket, snapshotObjectKey });
        } else {
          await deleteDocumentEmbeddings({ documentIri: input.documentIri });
        }
      }

      if (uploaded?.createdNewObject) {
        await deleteSourceDocument({
          bucket:    uploaded.bucket,
          objectKey: uploaded.objectKey,
        });
      }
    } catch (rollbackError) {
      const originalMessage  = error instanceof Error ? error.message : String(error);
      const rollbackMessage  = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Indexing failed and rollback also failed. original="${originalMessage}" rollback="${rollbackMessage}"`
      );
    }

    throw error;
  }
}
