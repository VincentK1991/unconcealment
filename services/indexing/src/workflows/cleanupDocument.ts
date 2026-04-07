import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PIPELINE_CONSTANTS } from "../constants/pipeline";
import type { GraphSnapshot } from "../types/graphSnapshot";

const {
  deleteGraphAssertions,
  restoreGraphAssertions,
  deleteDocumentEmbeddings,
  restoreDocumentEmbeddings,
  deleteSourceDocument,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: `${PIPELINE_CONSTANTS.retry.initialIntervalMs} milliseconds`,
    backoffCoefficient: PIPELINE_CONSTANTS.retry.backoffCoefficient,
    maximumInterval: `${PIPELINE_CONSTANTS.retry.maximumIntervalMs} milliseconds`,
    maximumAttempts: PIPELINE_CONSTANTS.retry.maximumAttempts,
    nonRetryableErrorTypes: ["NonRetryableDocumentInputError"],
  },
});

export interface CleanupDocumentInput {
  datasetId: string;
  documentIri: string;
}

export async function cleanupDocument(input: CleanupDocumentInput): Promise<void> {
  let graphSnapshot: GraphSnapshot | undefined;
  let deleted: Awaited<ReturnType<typeof deleteDocumentEmbeddings>> | undefined;

  try {
    graphSnapshot = await deleteGraphAssertions({
      datasetId: input.datasetId,
      documentIri: input.documentIri,
    });

    deleted = await deleteDocumentEmbeddings({
      documentIri: input.documentIri,
    });

    if (deleted.storageObjectKey) {
      await deleteSourceDocument({
        bucket: deleted.storageBucket ?? undefined,
        objectKey: deleted.storageObjectKey,
      });
    }
  } catch (error) {
    try {
      if (deleted?.snapshotBucket && deleted?.snapshotObjectKey) {
        await restoreDocumentEmbeddings({
          snapshotBucket: deleted.snapshotBucket,
          snapshotObjectKey: deleted.snapshotObjectKey,
        });
      }

      if (graphSnapshot && graphSnapshot.triples.length > 0) {
        await restoreGraphAssertions({ snapshot: graphSnapshot });
      }
    } catch (rollbackError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Cleanup failed and compensation also failed. original="${originalMessage}" rollback="${rollbackMessage}"`
      );
    }

    throw error;
  }
}
