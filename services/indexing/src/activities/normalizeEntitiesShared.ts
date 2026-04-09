/**
 * Shared types and utilities for the two-step entity normalization pipeline.
 * Not exported from activities/index.ts — internal to the normalize activities.
 *
 * Pipeline:
 *   normalizeEntitiesRuleBased → returns LlmCandidate[] handoff
 *   normalizeEntitiesLlm       → receives LlmCandidate[], writes accepted sameAs pairs
 */

export const ONTOLOGY_NS  = "http://localhost:4321/ontology/";
export const OWL_SAME_AS  = "http://www.w3.org/2002/07/owl#sameAs";
export const XSD_DATETIME = "http://www.w3.org/2001/XMLSchema#dateTime";
export const IS_CANONICAL = `${ONTOLOGY_NS}isCanonical`;

// ─── Handoff type (rule-based → LLM activity) ────────────────────────────────

/** Full entity pair passed from the rule-based step to the LLM step. */
export interface LlmCandidate {
  newIri:               string;
  newLabel:             string;
  newType:              string;
  newDescription:       string;
  candidateIri:         string;
  candidateLabel:       string;
  candidateType:        string;
  candidateDescription: string;
}

// ─── Graph entity (internal to rule-based) ───────────────────────────────────

export interface GraphEntity {
  iri:         string;
  label:       string;
  type:        string;
  description: string;
}

// ─── Output pair written to the normalization graph ──────────────────────────

export interface SameAsPair {
  subjectIri:          string;
  objectIri:           string;
  confidence:          number;
  normalizationMethod: string;
}

// ─── SPARQL response shapes ───────────────────────────────────────────────────

export interface SparqlResults {
  results?: { bindings?: SparqlBinding[] };
}

export interface SparqlBinding {
  entity?:      { value: string };
  label?:       { value: string };
  type?:        { value: string };
  description?: { value: string };
  score?:       { value: string };
}

// ─── Shared HTTP helpers ─────────────────────────────────────────────────────

export async function sparqlQuery(
  backendUrl: string,
  datasetId: string,
  sparql: string,
): Promise<SparqlResults> {
  const res = await fetch(
    `${backendUrl}/query/raw?dataset=${encodeURIComponent(datasetId)}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/sparql-query" },
      body:    sparql,
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`SPARQL query failed HTTP ${res.status} — ${body}`);
  }
  return res.json() as Promise<SparqlResults>;
}

export async function sparqlUpdate(
  backendUrl: string,
  datasetId: string,
  update: string,
): Promise<void> {
  const res = await fetch(
    `${backendUrl}/query/update?dataset=${encodeURIComponent(datasetId)}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/sparql-update" },
      body:    update,
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`SPARQL update failed HTTP ${res.status} — ${body}`);
  }
}

// ─── Shared write ─────────────────────────────────────────────────────────────

export async function writeSameAsPairs(
  backendUrl:    string,
  datasetId:     string,
  indexingRunId: string,
  namedGraph:    string,
  pairs:         SameAsPair[],
): Promise<void> {
  if (pairs.length === 0) return;

  const now = new Date().toISOString();
  const triples = pairs.map(p => {
    const s      = `<${p.subjectIri}>`;
    const o      = `<${p.objectIri}>`;
    const sameAs = `<${OWL_SAME_AS}>`;
    return (
      `    ${s} ${sameAs} ${o} .\n` +
      `    << ${s} ${sameAs} ${o} >>\n` +
      `      <${ONTOLOGY_NS}normalizationMethod> "${escapeSparql(p.normalizationMethod)}" ;\n` +
      `      <${ONTOLOGY_NS}confidence>          ${p.confidence} ;\n` +
      `      <${ONTOLOGY_NS}indexingRun>         "${escapeSparql(indexingRunId)}" ;\n` +
      `      <${ONTOLOGY_NS}transactionTime>     "${escapeSparql(now)}"^^<${XSD_DATETIME}> .`
    );
  }).join("\n");

  await sparqlUpdate(
    backendUrl,
    datasetId,
    `PREFIX owl: <http://www.w3.org/2002/07/owl#>\n\nINSERT DATA {\n  GRAPH <${namedGraph}> {\n${triples}\n  }\n}`,
  );
}

// ─── Canonical election ───────────────────────────────────────────────────────

interface PairRow { s: { value: string }; o: { value: string } }

/**
 * After new sameAs pairs are written, re-elects the canonical entity for every
 * cluster that contains at least one IRI from `touchedIris` (incremental).
 *
 * Election rule: highest in-degree (most often appearing as owl:sameAs ?object).
 * Tie-break: lexicographically first IRI.
 *
 * Writes `ex:isCanonical true` to the normalization graph for each elected
 * canonical, replacing any previous marker for the same cluster.
 */
export async function electAndWriteCanonicals(
  backendUrl:  string,
  datasetId:   string,
  touchedIris: Set<string>,
): Promise<void> {
  if (touchedIris.size === 0) return;

  const namedGraph = `urn:${datasetId}:normalization`;

  // Fetch all non-self sameAs pairs from the normalization graph
  const data = await sparqlQuery(backendUrl, datasetId, `
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?s ?o WHERE {
  GRAPH <${namedGraph}> {
    ?s owl:sameAs ?o .
    FILTER(?s != ?o)
  }
}`.trim());

  const pairs = (data.results?.bindings ?? []) as PairRow[];

  // Build union-find + in-degree over all pairs
  const parent   = new Map<string, string>();
  const inDegree = new Map<string, number>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p !== x) { const root = find(p); parent.set(x, root); return root; }
    return x;
  }
  function union(a: string, b: string): void { parent.set(find(a), find(b)); }

  for (const pair of pairs) {
    union(pair.s.value, pair.o.value);
    inDegree.set(pair.o.value, (inDegree.get(pair.o.value) ?? 0) + 1);
    if (!inDegree.has(pair.s.value)) inDegree.set(pair.s.value, 0);
  }

  // Group IRIs by cluster root
  const clusterMap = new Map<string, Set<string>>();
  for (const iri of inDegree.keys()) {
    const root = find(iri);
    if (!clusterMap.has(root)) clusterMap.set(root, new Set());
    clusterMap.get(root)!.add(iri);
  }

  // Process only clusters that contain at least one touched IRI (incremental)
  for (const members of clusterMap.values()) {
    if (![...members].some(m => touchedIris.has(m))) continue;

    const sorted = Array.from(members).sort((a, b) => {
      const diff = (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    });
    const canonical    = sorted[0]!;
    const memberValues = sorted.map(m => `<${m}>`).join(" ");

    // Remove old canonical marker for any member of this cluster, then set new one
    await sparqlUpdate(backendUrl, datasetId, `
PREFIX ex: <${ONTOLOGY_NS}>
DELETE { GRAPH <${namedGraph}> { ?m ex:isCanonical true } }
WHERE  { GRAPH <${namedGraph}> { VALUES ?m { ${memberValues} } ?m ex:isCanonical true } }`.trim());

    await sparqlUpdate(backendUrl, datasetId, `
PREFIX ex: <${ONTOLOGY_NS}>
INSERT DATA { GRAPH <${namedGraph}> { <${canonical}> ex:isCanonical true } }`.trim());
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function escapeSparql(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Extracts the local name from a full IRI (after the last '#' or '/'). */
export function localName(iri: string): string {
  return iri.replace(/.*[#/]/, "") || iri;
}
