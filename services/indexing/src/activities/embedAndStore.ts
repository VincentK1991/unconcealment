import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { PrismaClient, Prisma } from "@prisma/client";
import OpenAI from "openai";
import { PIPELINE_CONSTANTS } from "../constants/pipeline";
import { getObjectStorageClient, streamToBuffer } from "../config/objectStorage";
import type { DocumentChunkSnapshot, DocumentSnapshot } from "../types/documentSnapshot";
import { storeSnapshot } from "../utils/snapshotStorage";

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// OpenAI allows batching multiple chunks per API call.
// 100 chunks/call × 3 concurrent calls = 300 chunks in-flight at once.
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_CONCURRENCY = 3;

export interface EmbedAndStoreInput {
  datasetId: string;
  documentIri: string;
  textBucket: string;
  textObjectKey: string;
  sourceUrl: string;
  contentHash: string;
  mimeType: string;
  ocrEngine?: string;
  storageBucket: string;
  storageObjectKey: string;
  storagePath: string;
}

export interface EmbedAndStoreOutput {
  documentId: string;
  chunkIds: string[];
  snapshotBucket: string | null;
  snapshotObjectKey: string | null;
}

async function loadDocumentSnapshot(documentIri: string): Promise<DocumentSnapshot | null> {
  const document = await prisma.document.findUnique({ where: { documentIri } });
  if (!document) return null;

  const chunks = await prisma.$queryRaw<DocumentChunkSnapshot[]>(
    Prisma.sql`
      SELECT
        id::text,
        "documentId"::text AS "documentId",
        "documentIri"       AS "documentIri",
        "datasetId"         AS "datasetId",
        "chunkText"         AS "chunkText",
        "chunkIndex"        AS "chunkIndex",
        embedding::text     AS embedding,
        "sourceUrl"         AS "sourceUrl",
        "createdAt"::text   AS "createdAt"
      FROM document_chunks
      WHERE "documentId" = ${document.id}::uuid
      ORDER BY "chunkIndex" ASC
    `
  );

  return {
    document: {
      id: document.id,
      documentIri: document.documentIri,
      datasetId: document.datasetId,
      sourceUrl: document.sourceUrl,
      content: document.content,
      contentHash: document.contentHash,
      mimeType: document.mimeType,
      ocrEngine: document.ocrEngine,
      storageBucket: document.storageBucket,
      storageObjectKey: document.storageObjectKey,
      storagePath: document.storagePath,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    },
    chunks,
  };
}

/**
 * Embeds a single batch of chunks with exponential backoff on rate-limit / server errors.
 * Returns embeddings in the same order as the input chunks.
 */
async function embedBatchWithRetry(batch: string[], maxAttempts = 4): Promise<number[][]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await openai.embeddings.create({
        model: PIPELINE_CONSTANTS.models.embedding,
        input: batch,
      });
      return response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (err: unknown) {
      if (attempt === maxAttempts - 1) throw err;
      const status = (err as any)?.status;
      // Retry rate limits and transient server errors; everything else is re-thrown immediately.
      if (status === 429 || (typeof status === "number" && status >= 500)) {
        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 32_000);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

/**
 * Embeds all chunks using batched API calls with bounded concurrency.
 * Heartbeats after every batch so Temporal knows the activity is alive.
 */
async function embedAllChunks(chunks: string[]): Promise<number[][]> {
  const ctx = Context.current();

  // Build a queue of { startIdx, chunks } batches
  const queue: Array<{ startIdx: number; batch: string[] }> = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    queue.push({ startIdx: i, batch: chunks.slice(i, i + EMBEDDING_BATCH_SIZE) });
  }

  const embeddings: number[][] = new Array(chunks.length);
  let completed = 0;
  const total = chunks.length;

  ctx.heartbeat(`Starting embedding: 0/${total} chunks across ${queue.length} batches`);

  // Worker: drain the queue, serializing within each worker but running CONCURRENCY workers in parallel.
  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) return;

      const batchEmbeddings = await embedBatchWithRetry(item.batch);
      for (let i = 0; i < batchEmbeddings.length; i++) {
        embeddings[item.startIdx + i] = batchEmbeddings[i];
      }

      completed += item.batch.length;
      ctx.heartbeat(`Embedded ${completed}/${total} chunks`);
    }
  }

  await Promise.all(Array.from({ length: EMBEDDING_CONCURRENCY }, () => worker()));
  return embeddings;
}

function embeddingToVectorText(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw ApplicationFailure.nonRetryable(
      "Embedding vector is empty or invalid",
      "NonRetryableEmbeddingShapeError"
    );
  }

  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw ApplicationFailure.nonRetryable(
        `Embedding contains non-finite value at index ${i}: ${embedding[i]}`,
        "NonRetryableEmbeddingValueError"
      );
    }
  }

  return `[${embedding.join(",")}]`;
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(safeUnicodeSlice(text, start, start + size));
    start += size - overlap;
  }
  return chunks;
}

/**
 * Returns a substring without splitting UTF-16 surrogate pairs.
 * Prisma query parameter serialization can fail on lone surrogates.
 */
function safeUnicodeSlice(text: string, start: number, end: number): string {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));

  // If start lands on a low surrogate, advance one code unit.
  if (s < text.length) {
    const ch = text.charCodeAt(s);
    if (ch >= 0xdc00 && ch <= 0xdfff) s++;
  }

  // If end lands after a high surrogate (without its low pair), back up one code unit.
  if (e > s) {
    const prev = text.charCodeAt(e - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) e--;
  }

  return text.slice(s, e);
}

export async function embedAndStore(
  input: EmbedAndStoreInput
): Promise<EmbedAndStoreOutput> {
  const ctx = Context.current();

  // 1. Fetch extracted text from MinIO.
  ctx.heartbeat("Fetching document text from storage");
  const storageClient = getObjectStorageClient();
  const textStream = await storageClient.getObject(input.textBucket, input.textObjectKey);
  const text = (await streamToBuffer(textStream)).toString("utf8");

  // 2. Load the previous snapshot (before any writes) and immediately persist it to MinIO.
  //    Storing BEFORE the DB transaction ensures rollback is possible even if the upsert
  //    succeeds but a later step fails.
  ctx.heartbeat("Loading previous document snapshot");
  const previousSnapshot = await loadDocumentSnapshot(input.documentIri);

  let snapshotBucket: string | null = null;
  let snapshotObjectKey: string | null = null;
  if (previousSnapshot) {
    ctx.heartbeat("Persisting previous snapshot to storage");
    snapshotObjectKey = await storeSnapshot(
      input.storageBucket,
      input.datasetId,
      input.documentIri,
      previousSnapshot
    );
    snapshotBucket = input.storageBucket;
  }

  // 3. Chunk and embed (the expensive step — may take many minutes for large documents).
  const chunks = chunkText(text, PIPELINE_CONSTANTS.chunk.size, PIPELINE_CONSTANTS.chunk.overlap);
  if (chunks.length === 0) {
    throw ApplicationFailure.nonRetryable(
      `Document ${input.documentIri} produced no text chunks — cannot index empty content`,
      "NonRetryableDocumentInputError"
    );
  }

  const allEmbeddings = await embedAllChunks(chunks);

  // 4. Write document record and all chunks atomically.
  ctx.heartbeat(`Writing ${chunks.length} chunks to database`);
  const result = await prisma.$transaction(
    async (tx) => {
      const document = await tx.document.upsert({
        where:  { documentIri: input.documentIri },
        create: {
          documentIri:      input.documentIri,
          datasetId:        input.datasetId,
          sourceUrl:        input.sourceUrl,
          content:          text,
          contentHash:      input.contentHash,
          mimeType:         input.mimeType,
          ocrEngine:        input.ocrEngine,
          storageBucket:    input.storageBucket,
          storageObjectKey: input.storageObjectKey,
          storagePath:      input.storagePath,
        },
        update: {
          datasetId:        input.datasetId,
          sourceUrl:        input.sourceUrl,
          content:          text,
          contentHash:      input.contentHash,
          mimeType:         input.mimeType,
          ocrEngine:        input.ocrEngine,
          storageBucket:    input.storageBucket,
          storageObjectKey: input.storageObjectKey,
          storagePath:      input.storagePath,
        },
      });

      await tx.documentChunk.deleteMany({ where: { documentId: document.id } });

      const chunkIds: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const vectorText = embeddingToVectorText(allEmbeddings[i]);
        const inserted = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            INSERT INTO document_chunks
              ("documentId", "documentIri", "datasetId", "chunkText", "chunkIndex", embedding, "sourceUrl")
            VALUES (
              ${document.id}::uuid,
              ${input.documentIri},
              ${input.datasetId},
              ${chunks[i]},
              ${i},
              CAST(${vectorText} AS vector),
              ${input.sourceUrl}
            )
            RETURNING id::text AS id
          `
        );
        chunkIds.push(inserted[0].id);
      }

      return { documentId: document.id, chunkIds };
    },
    { timeout: 120_000 } // 2-minute DB transaction timeout
  );

  return {
    ...result,
    snapshotBucket,
    snapshotObjectKey,
  };
}
