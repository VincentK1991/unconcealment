/**
 * Client for the Java backend SPARQL gateway.
 * All queries from the web UI route through the backend —
 * never directly to Fuseki — to ensure consistent reasoning.
 */

const BACKEND_URL = import.meta.env.BACKEND_URL ?? "http://localhost:8080";

export type QueryRoute = "reasoned" | "raw" | "text" | "tbox";

export async function sparqlQuery(
  route: QueryRoute,
  datasetId: string,
  body: string
): Promise<unknown> {
  const res = await fetch(
    `${BACKEND_URL}/query/${route}?dataset=${encodeURIComponent(datasetId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/sparql-query" },
      body,
    }
  );
  if (!res.ok) {
    throw new Error(`Backend query failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function textSearch(
  datasetId: string,
  searchText: string
): Promise<unknown> {
  return sparqlQuery("text", datasetId, searchText);
}
