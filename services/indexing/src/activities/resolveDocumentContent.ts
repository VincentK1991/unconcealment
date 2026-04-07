import { createHash } from "crypto";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { ApplicationFailure } from "@temporalio/common";
import { getObjectStorageClient, streamToBuffer } from "../config/objectStorage";

const execFileAsync = promisify(execFile);

export interface ResolveDocumentContentInput {
  bucket: string;
  objectKey: string;
  mimeType: string;
}

export interface ResolveDocumentContentOutput {
  textBucket: string;
  textObjectKey: string;
  contentHash: string;
  mimeType: string;
  ocrEngine?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isPdfObject(input: ResolveDocumentContentInput): boolean {
  return input.mimeType === "application/pdf" || input.objectKey.toLowerCase().endsWith(".pdf");
}

async function runLiteparse(pdfPath: string): Promise<string> {
  const liteparseCommand = process.env.LITEPARSE_COMMAND ?? "liteparse";
  const { stdout } = await execFileAsync(
    liteparseCommand,
    ["parse", pdfPath, "--format", "text"],
    {
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  const text = stdout?.toString().trim();
  if (!text) {
    throw new Error("liteparse returned empty output");
  }

  return text;
}

/**
 * Derives a stable MinIO object key for the extracted text from the source object key.
 * Example: "raw/economic-census/doc-key/abc123.pdf" → "raw/economic-census/doc-key/abc123-text.txt"
 */
function textObjectKeyFor(sourceObjectKey: string): string {
  return sourceObjectKey.replace(/\.[^/.]+$/, "") + "-text.txt";
}

async function storeText(client: ReturnType<typeof getObjectStorageClient>, bucket: string, objectKey: string, text: string): Promise<void> {
  const buf = Buffer.from(text, "utf8");
  await client.putObject(bucket, objectKey, buf, buf.length, {
    "Content-Type": "text/plain; charset=utf-8",
  });
}

export async function resolveDocumentContent(
  input: ResolveDocumentContentInput
): Promise<ResolveDocumentContentOutput> {
  const client = getObjectStorageClient();
  const textObjectKey = textObjectKeyFor(input.objectKey);

  const objectStream = await client.getObject(input.bucket, input.objectKey);
  const bytes = await streamToBuffer(objectStream);

  if (input.mimeType.startsWith("text/plain")) {
    const normalized = bytes.toString("utf8").trim();
    await storeText(client, input.bucket, textObjectKey, normalized);
    return {
      textBucket: input.bucket,
      textObjectKey,
      contentHash: sha256(normalized),
      mimeType: "text/plain",
    };
  }

  if (!isPdfObject(input)) {
    throw ApplicationFailure.nonRetryable(
      `Unsupported source mime type for content resolution: ${input.mimeType}`,
      "NonRetryableDocumentInputError"
    );
  }

  const tempPath = path.join(
    tmpdir(),
    `unconcealment-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
  );

  await fs.writeFile(tempPath, bytes);
  try {
    const ocrText = await runLiteparse(tempPath);
    await storeText(client, input.bucket, textObjectKey, ocrText);
    return {
      textBucket: input.bucket,
      textObjectKey,
      contentHash: sha256(ocrText),
      mimeType: "application/pdf",
      ocrEngine: "liteparse",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OCR extraction failed with liteparse: ${message}`);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}
