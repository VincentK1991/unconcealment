import { PrismaClient, Prisma } from "@prisma/client";
import type { DocumentChunkSnapshot, DocumentSnapshot } from "../types/documentSnapshot";
import { storeSnapshot } from "../utils/snapshotStorage";

const prisma = new PrismaClient();

async function loadDocumentSnapshot(documentIri: string): Promise<DocumentSnapshot | null> {
  const document = await prisma.document.findUnique({
    where: { documentIri },
  });

  if (!document) {
    return null;
  }

  const chunks = await prisma.$queryRaw<DocumentChunkSnapshot[]>(
    Prisma.sql`
      SELECT
        id::text,
        "documentId"::text AS "documentId",
        "documentIri" AS "documentIri",
        "datasetId" AS "datasetId",
        "chunkText" AS "chunkText",
        "chunkIndex" AS "chunkIndex",
        embedding::text AS embedding,
        "sourceUrl" AS "sourceUrl",
        "createdAt"::text AS "createdAt"
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

export interface DeleteDocumentEmbeddingsInput {
  documentIri: string;
}

export interface DeleteDocumentEmbeddingsOutput {
  storageBucket: string | null;
  storageObjectKey: string | null;
  snapshotBucket: string | null;
  snapshotObjectKey: string | null;
}

export async function deleteDocumentEmbeddings(
  input: DeleteDocumentEmbeddingsInput
): Promise<DeleteDocumentEmbeddingsOutput> {
  const snapshot = await loadDocumentSnapshot(input.documentIri);
  if (!snapshot) {
    return {
      storageBucket: null,
      storageObjectKey: null,
      snapshotBucket: null,
      snapshotObjectKey: null,
    };
  }

  const bucket = snapshot.document.storageBucket;
  if (bucket) {
    const snapshotObjectKey = await storeSnapshot(
      bucket,
      snapshot.document.datasetId,
      input.documentIri,
      snapshot
    );

    await prisma.document.delete({ where: { documentIri: input.documentIri } });

    return {
      storageBucket: snapshot.document.storageBucket,
      storageObjectKey: snapshot.document.storageObjectKey,
      snapshotBucket: bucket,
      snapshotObjectKey,
    };
  }

  await prisma.document.delete({ where: { documentIri: input.documentIri } });

  return {
    storageBucket: snapshot.document.storageBucket,
    storageObjectKey: snapshot.document.storageObjectKey,
    snapshotBucket: null,
    snapshotObjectKey: null,
  };
}
