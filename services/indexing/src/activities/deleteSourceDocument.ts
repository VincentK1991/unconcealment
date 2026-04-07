import { buildStorageLocation, getObjectStorageClient } from "../config/objectStorage";

export interface DeleteSourceDocumentInput {
  bucket?: string;
  objectKey: string;
}

export async function deleteSourceDocument(input: DeleteSourceDocumentInput): Promise<void> {
  const client = getObjectStorageClient();
  const location = input.bucket
    ? { bucket: input.bucket, objectKey: input.objectKey, storagePath: `${input.bucket}/${input.objectKey}` }
    : buildStorageLocation(input.objectKey);

  try {
    await client.removeObject(location.bucket, location.objectKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("NotFound") ||
      message.includes("NoSuchKey") ||
      message.includes("The specified key does not exist")
    ) {
      return;
    }
    throw error;
  }
}
