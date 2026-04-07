import { createHash } from "crypto";
import { getObjectStorageClient, getObjectStoragePrefix } from "../config/objectStorage";
import type { DocumentSnapshot } from "../types/documentSnapshot";

/**
 * Serializes a DocumentSnapshot to MinIO and returns the object key.
 * Snapshots contain chunk embeddings (~15 KB each serialized) and full document
 * content, so they must never travel through Temporal's gRPC channel directly.
 * Instead, activities store snapshots here and pass bucket+key references through Temporal.
 */
export async function storeSnapshot(
  bucket: string,
  datasetId: string,
  documentIri: string,
  snapshot: DocumentSnapshot
): Promise<string> {
  const client = getObjectStorageClient();
  const iriHash = createHash("sha256").update(documentIri).digest("hex").slice(0, 16);
  const prefix = getObjectStoragePrefix();
  const objectKey = [prefix, datasetId, "snapshots", `${iriHash}.json`]
    .filter(Boolean)
    .join("/");
  const buf = Buffer.from(JSON.stringify(snapshot), "utf8");
  await client.putObject(bucket, objectKey, buf, buf.length, {
    "Content-Type": "application/json",
  });
  return objectKey;
}
