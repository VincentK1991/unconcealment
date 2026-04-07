import { PrismaClient, Prisma } from "@prisma/client";
import type { DocumentChunkSnapshot, DocumentSnapshot } from "../types/documentSnapshot";
import { getObjectStorageClient, streamToBuffer } from "../config/objectStorage";

const prisma = new PrismaClient();

function vectorLiteral(embedding: string | null): Prisma.Sql {
  if (!embedding) {
    return Prisma.sql`NULL`;
  }

  const escaped = embedding.replace(/'/g, "''");
  return Prisma.sql`${Prisma.raw(`'${escaped}'::vector`)}`;
}

async function restoreChunks(tx: Prisma.TransactionClient, chunks: DocumentChunkSnapshot[]): Promise<void> {
  for (const chunk of chunks) {
    await tx.$queryRaw(
      Prisma.sql`
        INSERT INTO document_chunks
          (id, "documentId", "documentIri", "datasetId", "chunkText", "chunkIndex", embedding, "sourceUrl", "createdAt")
        VALUES (
          ${chunk.id}::uuid,
          ${chunk.documentId}::uuid,
          ${chunk.documentIri},
          ${chunk.datasetId},
          ${chunk.chunkText},
          ${chunk.chunkIndex},
          ${vectorLiteral(chunk.embedding)},
          ${chunk.sourceUrl},
          ${new Date(chunk.createdAt)}
        )
      `
    );
  }
}

export interface RestoreDocumentEmbeddingsInput {
  snapshotBucket: string;
  snapshotObjectKey: string;
}

export async function restoreDocumentEmbeddings(
  input: RestoreDocumentEmbeddingsInput
): Promise<void> {
  const client = getObjectStorageClient();
  const stream = await client.getObject(input.snapshotBucket, input.snapshotObjectKey);
  const bytes = await streamToBuffer(stream);
  const snapshot: DocumentSnapshot = JSON.parse(bytes.toString("utf8"));

  await prisma.$transaction(async (tx) => {
    await tx.document.deleteMany({
      where: { documentIri: snapshot.document.documentIri },
    });

    await tx.document.create({
      data: {
        id: snapshot.document.id,
        documentIri: snapshot.document.documentIri,
        datasetId: snapshot.document.datasetId,
        sourceUrl: snapshot.document.sourceUrl,
        content: snapshot.document.content,
        contentHash: snapshot.document.contentHash,
        mimeType: snapshot.document.mimeType,
        ocrEngine: snapshot.document.ocrEngine,
        storageBucket: snapshot.document.storageBucket,
        storageObjectKey: snapshot.document.storageObjectKey,
        storagePath: snapshot.document.storagePath,
        createdAt: new Date(snapshot.document.createdAt),
        updatedAt: new Date(snapshot.document.updatedAt),
      },
    });

    await restoreChunks(tx, snapshot.chunks);
  });
}
