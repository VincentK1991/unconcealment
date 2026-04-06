import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_SIZE = 800;   // characters
const CHUNK_OVERLAP = 100;

export interface EmbedAndStoreInput {
  datasetId: string;
  documentIri: string;
  text: string;
  sourceUrl: string;
}

export interface EmbedAndStoreOutput {
  chunkIds: string[];
}

/**
 * Activity: chunk the document text, generate OpenAI embeddings,
 * and store chunks + vectors in Postgres via Prisma.
 *
 * Uses text-embedding-3-small (1536 dimensions).
 * The Postgres row IDs are returned so extractEntities can reference them
 * in RDF-star provenance annotations.
 */
export async function embedAndStore(
  input: EmbedAndStoreInput
): Promise<EmbedAndStoreOutput> {
  const chunks = chunkText(input.text, CHUNK_SIZE, CHUNK_OVERLAP);
  const chunkIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Generate embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });
    const vector = embeddingResponse.data[0].embedding;

    // Store in Postgres — pgvector stores the embedding as a raw SQL expression
    // Prisma does not natively support vector(1536) so we use $executeRaw for the insert
    const result = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO document_chunks (document_iri, dataset_id, chunk_text, chunk_index, embedding, source_url)
      VALUES (
        ${input.documentIri},
        ${input.datasetId},
        ${chunk},
        ${i},
        ${`[${vector.join(",")}]`}::vector,
        ${input.sourceUrl}
      )
      RETURNING id
    `;

    chunkIds.push(result[0].id);
  }

  return { chunkIds };
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}
