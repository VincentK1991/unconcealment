import { namedGraphs } from "../config/manifest";
import type { GraphSnapshot } from "../types/graphSnapshot";
import { buildGraphSnapshot, type SparqlJsonRow } from "../utils/sparqlSnapshot";

export interface DeleteGraphAssertionsInput {
  datasetId: string;
  documentIri: string;
}

interface SparqlResultsResponse {
  results?: {
    bindings?: SparqlJsonRow[];
  };
}

function escapeSparqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function fetchGraphSnapshot(input: DeleteGraphAssertionsInput): Promise<GraphSnapshot> {
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphs = namedGraphs(input.datasetId);
  const snapshotQuery = `
PREFIX ex: <http://localhost:4321/ontology/>
SELECT ?s ?p ?o ?annP ?annO WHERE {
  GRAPH <${graphs.aboxAsserted}> {
    << ?s ?p ?o >> ex:sourceDocument <${input.documentIri}> .
    OPTIONAL { << ?s ?p ?o >> ?annP ?annO . }
  }
}
`;

  const response = await fetch(`${backendUrl}/query/raw?dataset=${encodeURIComponent(input.datasetId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-query" },
    body: snapshotQuery,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph snapshot failed: HTTP ${response.status} — ${body}`);
  }

  const payload = (await response.json()) as SparqlResultsResponse;
  return buildGraphSnapshot(input.datasetId, input.documentIri, payload.results?.bindings ?? []);
}

export async function deleteGraphAssertions(
  input: DeleteGraphAssertionsInput
): Promise<GraphSnapshot> {
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphs = namedGraphs(input.datasetId);
  const snapshot = await fetchGraphSnapshot(input);

  const deleteSparql = `
PREFIX ex: <http://localhost:4321/ontology/>
DELETE {
  GRAPH <${graphs.aboxAsserted}> {
    ?s ?p ?o .
    << ?s ?p ?o >> ?annP ?annO .
  }
}
WHERE {
  GRAPH <${graphs.aboxAsserted}> {
    << ?s ?p ?o >> ex:sourceDocument <${input.documentIri}> .
    OPTIONAL { << ?s ?p ?o >> ?annP ?annO . }
  }
}
`;

  const response = await fetch(`${backendUrl}/query/update?dataset=${encodeURIComponent(input.datasetId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-update" },
    body: deleteSparql,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Graph delete failed for dataset=${input.datasetId} document=${escapeSparqlLiteral(input.documentIri)}: HTTP ${response.status} — ${body}`
    );
  }

  return snapshot;
}
