import { ApplicationFailure } from "@temporalio/common";
import type { ExtractionEntity, ExtractionRelationship } from "./extractEntities";
import { PIPELINE_CONSTANTS } from "../constants/pipeline";

export interface AssertToGraphInput {
  datasetId:     string;
  documentIri:   string;
  indexingRunId: string;
  entities:      ExtractionEntity[];
  relationships: ExtractionRelationship[];
}

const ASSERT_TIMEOUT_MS = 60_000; // 60 s — Java should be fast once the payload is received

/**
 * Activity: assert extracted entities and relationships into the knowledge graph.
 * Posts the raw LLM extraction payload to POST /ingest/assertions on the Java backend.
 *
 * Java is responsible for:
 *   - Minting deterministic UUID entity IRIs (baseUri/entity/{uuid})
 *   - Resolving ontology local names → full IRIs
 *   - Building RDF-star SPARQL INSERT DATA via Apache Jena
 *   - Writing triples + provenance to the dataset's abox:asserted named graph
 *
 * Error classification:
 *   4xx (except 429)  → NonRetryableGraphAssertionError (bad payload; retrying won't help)
 *   429 / 5xx / network → retryable (backend overloaded or temporarily unavailable)
 */
export async function assertToGraph(input: AssertToGraphInput): Promise<void> {
  if (input.entities.length === 0) return;

  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const endpoint = `${backendUrl}/ingest/assertions?dataset=${encodeURIComponent(input.datasetId)}`;

  const payload = {
    documentIri:      input.documentIri,
    indexingRunId:    input.indexingRunId,
    extractionMethod: PIPELINE_CONSTANTS.extraction.method,
    extractedAt:      new Date().toISOString(),
    entities:         input.entities,
    relationships:    input.relationships,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSERT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as any)?.name === "AbortError") {
      throw new Error(
        `assertToGraph timed out after ${ASSERT_TIMEOUT_MS / 1000}s for dataset=${input.datasetId}`
      );
    }
    throw new Error(`assertToGraph network error for dataset=${input.datasetId}: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    const message = `assertToGraph failed for dataset=${input.datasetId}: HTTP ${res.status} — ${body}`;

    // 4xx except rate-limit → payload is invalid; retrying won't help
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw ApplicationFailure.nonRetryable(message, "NonRetryableGraphAssertionError");
    }

    // 429 / 5xx → transient; Temporal will retry
    throw new Error(message);
  }
}
