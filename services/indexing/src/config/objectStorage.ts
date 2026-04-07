import { Client } from "minio";

export interface ObjectStorageLocation {
  bucket: string;
  objectKey: string;
  storagePath: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

export function getObjectStorageClient(): Client {
  return new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? "9000"),
    useSSL: parseBoolean(process.env.MINIO_USE_SSL, false),
    accessKey: process.env.MINIO_ROOT_USER ?? "admin",
    secretKey: process.env.MINIO_ROOT_PASSWORD ?? "test1234",
  });
}

export function getObjectStorageBucket(): string {
  return process.env.MINIO_BUCKET ?? "documents";
}

export function getObjectStoragePrefix(): string {
  const raw = process.env.MINIO_OBJECT_PREFIX ?? "raw";
  return raw.replace(/^\/+|\/+$/g, "");
}

export function buildStorageLocation(objectKey: string): ObjectStorageLocation {
  const bucket = getObjectStorageBucket();
  return {
    bucket,
    objectKey,
    storagePath: `${bucket}/${objectKey}`,
  };
}

export async function ensureBucketExists(client: Client, bucket: string): Promise<void> {
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket);
  }
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
