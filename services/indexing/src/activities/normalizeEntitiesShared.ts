/**
 * Shared types and utilities for the two-step entity normalization pipeline.
 * Not exported from activities/index.ts — internal to the normalize activities.
 *
 * Pipeline:
 *   normalizeEntitiesRuleBased → returns LlmCandidate[] handoff
 *   normalizeEntitiesLlm       → receives LlmCandidate[], writes accepted sameAs pairs
 */

export const ONTOLOGY_NS  = "https://kg.unconcealment.io/ontology/";
export const OWL_SAME_AS  = "http://www.w3.org/2002/07/owl#sameAs";
export const XSD_DATETIME = "http://www.w3.org/2001/XMLSchema#dateTime";

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
