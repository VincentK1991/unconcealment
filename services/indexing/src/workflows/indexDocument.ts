import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { extractEntities, assertToGraph, embedAndStore } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 3,
  },
});

export interface IndexDocumentInput {
  /** Dataset id from manifest.yaml (e.g. "economic-census") */
  datasetId: string;
  /** IRI that will be minted for this document in the RDF graph */
  documentIri: string;
  /** Raw document text to be indexed */
  text: string;
  /** Original source URL or file path */
  sourceUrl: string;
}

/**
 * Temporal workflow: index a single document into the knowledge graph.
 *
 * Steps:
 *   1. embedAndStore   — chunk text, generate embeddings, store in Postgres via Prisma
 *   2. extractEntities — call GPT-4o with ontology context, return RDF triples as JSON-LD
 *   3. assertToGraph   — SPARQL INSERT triples with RDF-star provenance into abox:asserted
 *
 * The workflow is parameterized by datasetId — no domain vocabulary is hardcoded here.
 * Ontology context for extraction is fetched from the graph at activity time.
 */
export async function indexDocument(input: IndexDocumentInput): Promise<void> {
  // Step 1: chunk, embed, and store in Postgres
  const { chunkIds } = await embedAndStore({
    datasetId: input.datasetId,
    documentIri: input.documentIri,
    text: input.text,
    sourceUrl: input.sourceUrl,
  });

  // Step 2: extract entities and relationships using GPT-4o + ontology context
  const { triples } = await extractEntities({
    datasetId: input.datasetId,
    documentIri: input.documentIri,
    text: input.text,
    chunkIds,
  });

  // Step 3: assert triples into the graph with RDF-star provenance
  await assertToGraph({
    datasetId: input.datasetId,
    documentIri: input.documentIri,
    triples,
  });
}
