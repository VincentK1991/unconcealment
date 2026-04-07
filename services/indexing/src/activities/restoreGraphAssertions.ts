import { namedGraphs } from "../config/manifest";
import type { GraphSnapshot } from "../types/graphSnapshot";
import { buildInsertDataForGraphSnapshot } from "../utils/sparqlSnapshot";

export interface RestoreGraphAssertionsInput {
  snapshot: GraphSnapshot;
}

export async function restoreGraphAssertions(
  input: RestoreGraphAssertionsInput
): Promise<void> {
  if (input.snapshot.triples.length === 0) {
    return;
  }

  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphs = namedGraphs(input.snapshot.datasetId);
  const sparql = buildInsertDataForGraphSnapshot(input.snapshot, graphs.aboxAsserted);

  const response = await fetch(`${backendUrl}/query/update?dataset=${encodeURIComponent(input.snapshot.datasetId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-update" },
    body: sparql,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph restore failed: HTTP ${response.status} — ${body}`);
  }
}
