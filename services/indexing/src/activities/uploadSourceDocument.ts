import { ApplicationFailure } from "@temporalio/common";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  buildStorageLocation,
  ensureBucketExists,
  getObjectStorageClient,
  getObjectStoragePrefix,
} from "../config/objectStorage";

export interface UploadSourceDocumentInput {
  datasetId: string;
  documentKey: string;
  sourceUrl: string;
  sourcePath?: string;
  text?: string;
}

export interface UploadSourceDocumentOutput {
  bucket: string;
  objectKey: string;
  storagePath: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
  createdNewObject: boolean;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType.startsWith("text/plain")) return ".txt";
  return ".bin";
}

function guessMimeType(sourceName: string | undefined, fallback?: string): string {
  const normalizedFallback = fallback?.split(";")[0]?.trim();
  if (normalizedFallback) {
    return normalizedFallback;
  }

  if (sourceName?.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }

  if (sourceName?.toLowerCase().endsWith(".txt")) {
    return "text/plain";
  }

  return "application/octet-stream";
}

async function loadSourceBytes(input: UploadSourceDocumentInput): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
  if (input.text && input.text.trim().length > 0) {
    const normalized = input.text.trim();
    return {
      bytes: Buffer.from(normalized, "utf8"),
      mimeType: "text/plain",
      extension: ".txt",
    };
  }

  if (input.sourcePath) {
    const bytes = await fs.readFile(input.sourcePath);
    const mimeType = guessMimeType(input.sourcePath);
    return {
      bytes,
      mimeType,
      extension: path.extname(input.sourcePath) || extensionFromMimeType(mimeType),
    };
  }

  if (!input.sourceUrl.toLowerCase().startsWith("http://") && !input.sourceUrl.toLowerCase().startsWith("https://")) {
    throw ApplicationFailure.nonRetryable(
      `sourceUrl must be an HTTP(S) URL or provide sourcePath/text: ${input.sourceUrl}`,
      "NonRetryableDocumentInputError"
    );
  }

  const response = await fetch(input.sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source document (HTTP ${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const url = new URL(input.sourceUrl);
  const fileName = url.pathname.split("/").filter(Boolean).pop();
  const mimeType = guessMimeType(fileName, response.headers.get("content-type") ?? undefined);

  return {
    bytes,
    mimeType,
    extension: path.extname(fileName ?? "") || extensionFromMimeType(mimeType),
  };
}

export async function uploadSourceDocument(
  input: UploadSourceDocumentInput
): Promise<UploadSourceDocumentOutput> {
  const { bytes, mimeType, extension } = await loadSourceBytes(input);
  const contentHash = sha256(bytes);
  const objectKey = [
    getObjectStoragePrefix(),
    input.datasetId,
    input.documentKey,
    `${contentHash}${extension.toLowerCase()}`,
  ]
    .filter(Boolean)
    .join("/");
  const location = buildStorageLocation(objectKey);
  const client = getObjectStorageClient();

  await ensureBucketExists(client, location.bucket);

  let createdNewObject = false;
  try {
    await client.statObject(location.bucket, location.objectKey);
  } catch {
    createdNewObject = true;
    await client.putObject(location.bucket, location.objectKey, bytes, bytes.length, {
      "Content-Type": mimeType,
    });
  }

  return {
    ...location,
    mimeType,
    contentHash,
    sizeBytes: bytes.length,
    createdNewObject,
  };
}
