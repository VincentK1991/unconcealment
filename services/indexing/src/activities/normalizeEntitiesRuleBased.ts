import { PIPELINE_CONSTANTS } from "../constants/pipeline";
import {
  type GraphEntity,
  type LlmCandidate,
  type SameAsPair,
  type SparqlBinding,
  type SparqlResults,
  ONTOLOGY_NS,
  OWL_SAME_AS,
  electAndWriteCanonicals,
  escapeSparql,
  sparqlQuery,
  sparqlUpdate,
  writeSameAsPairs,
} from "./normalizeEntitiesShared";

export type { LlmCandidate };

// ─── I/O types ───────────────────────────────────────────────────────────────

export interface NormalizeEntitiesRuleBasedInput {
  datasetId:     string;
  indexingRunId: string;
}

export interface NormalizeEntitiesRuleBasedOutput {
  /** Number of high-confidence sameAs pairs written directly by this step (includes intra-batch pairs). */
  highPairsAsserted:     number;
  /** Medium-confidence pairs to be judged by the LLM step. */
  llmCandidates:         LlmCandidate[];
  /** Total new entities examined in this run. */
  totalEntities:         number;
  /** Pairs matched by exact label (score === 1.0), subset of highConfidenceMatches. */
  exactMatches:          number;
  /** Pairs matched at high confidence (≥ 0.92), includes exact matches. */
  highConfidenceMatches: number;
  /** Number of candidates sent to the LLM step (= llmCandidates.length). */
  sentToLlm:             number;
  /** Entities for which the graph returned zero candidates. */
  noCandidate:           number;
}

// ─── Activity ────────────────────────────────────────────────────────────────

/**
 * Activity: rule-based entity normalization (step 1 of 2).
 *
 * For each entity newly asserted in this indexing run:
 *   1. Fetch top-K candidates via Jena-text (Lucene) on rdfs:label — no full scan.
 *   2. Score each candidate with Jaro-Winkler on normalised labels.
 *   3. High confidence (≥ 0.92): write owl:sameAs immediately to the normalization graph.
 *   4. Medium confidence (0.75–0.92): return as LlmCandidate[] for the LLM step.
 *   5. Low confidence (< 0.75): discard.
 *
 * Entities from the current indexing run are excluded from the candidate set
 * (post-fetch IRI filter) to prevent a new entity matching its siblings.
 */
export async function normalizeEntitiesRuleBased(
  input: NormalizeEntitiesRuleBasedInput,
): Promise<NormalizeEntitiesRuleBasedOutput> {
  const backendUrl    = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphAsserted = `urn:${input.datasetId}:abox:asserted`;
  const graphNorm     = `urn:${input.datasetId}:normalization`;

  const newEntities = await fetchNewEntities(backendUrl, input.datasetId, input.indexingRunId, graphAsserted);
  if (newEntities.length === 0) {
    return {
      highPairsAsserted: 0, llmCandidates: [],
      totalEntities: 0, exactMatches: 0, highConfidenceMatches: 0, sentToLlm: 0, noCandidate: 0,
    };
  }

  const newEntityIris    = new Set(newEntities.map(e => e.iri));
  const highPairs:        SameAsPair[]    = [];
  const llmCandidates:   LlmCandidate[]  = [];

  // ── Intra-batch dedup ──────────────────────────────────────────────────────
  // Pairwise Jaro-Winkler over entities extracted in this same indexing run.
  // Starting j at i+1 avoids self-comparisons and symmetric duplicates without
  // needing an explicit IRI ordering check.
  const { highConfidenceThreshold, lowConfidenceThreshold } = PIPELINE_CONSTANTS.normalization;
  let exactMatches          = 0;
  let highConfidenceMatches = 0;
  let noCandidate           = 0;

  for (let i = 0; i < newEntities.length; i++) {
    for (let j = i + 1; j < newEntities.length; j++) {
      const a     = newEntities[i]!;
      const b     = newEntities[j]!;
      if (a.iri === b.iri) continue; // same entity minted from multiple chunks — skip self-loop
      const score = jaroWinkler(normalizeLabel(a.label), normalizeLabel(b.label));
      if (score >= highConfidenceThreshold) {
        if (score === 1.0) exactMatches++;
        highConfidenceMatches++;
        highPairs.push({
          subjectIri:          a.iri,
          objectIri:           b.iri,
          confidence:          score,
          normalizationMethod: score === 1.0 ? "exact-label" : "jaro-winkler",
        });
      }
    }
  }

  // ── Graph-lookup normalization ─────────────────────────────────────────────
  for (const entity of newEntities) {
    const candidates = await fetchCandidatesByLabel(
      backendUrl,
      input.datasetId,
      entity.label,
      graphAsserted,
      newEntityIris,
    );

    if (candidates.length === 0) {
      noCandidate++;
      continue;
    }

    for (const candidate of candidates) {
      const score = jaroWinkler(normalizeLabel(entity.label), normalizeLabel(candidate.label));

      if (score >= highConfidenceThreshold) {
        if (score === 1.0) exactMatches++;
        highConfidenceMatches++;
        highPairs.push({
          subjectIri:          entity.iri,
          objectIri:           candidate.iri,
          confidence:          score,
          normalizationMethod: score === 1.0 ? "exact-label" : "jaro-winkler",
        });
      } else if (score >= lowConfidenceThreshold) {
        llmCandidates.push({
          newIri:               entity.iri,
          newLabel:             entity.label,
          newType:              entity.type,
          newDescription:       entity.description,
          candidateIri:         candidate.iri,
          candidateLabel:       candidate.label,
          candidateType:        candidate.type,
          candidateDescription: candidate.description,
        });
      }
    }
  }

  await writeSameAsPairs(backendUrl, input.datasetId, input.indexingRunId, graphNorm, highPairs);
  await electAndWriteCanonicals(backendUrl, input.datasetId, newEntityIris);

  return {
    highPairsAsserted:     highPairs.length,
    llmCandidates,
    totalEntities:         newEntities.length,
    exactMatches,
    highConfidenceMatches,
    sentToLlm:             llmCandidates.length,
    noCandidate,
  };
}

// ─── Rollback (also covers pairs written by the LLM step) ────────────────────

/**
 * Deletes all owl:sameAs triples from the normalization graph that carry the
 * given ex:indexingRun annotation. Used by the workflow rollback for both
 * normalizeEntitiesRuleBased and normalizeEntitiesLlm.
 */
export async function deleteNormalization(input: {
  datasetId:     string;
  indexingRunId: string;
}): Promise<void> {
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const namedGraph = `urn:${input.datasetId}:normalization`;
  const sameAs     = `<${OWL_SAME_AS}>`;

  // Collect affected IRIs before deletion so we can re-elect canonicals afterward
  const affectedData = await sparqlQuery(backendUrl, input.datasetId, `
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?s ?o WHERE {
  GRAPH <${namedGraph}> {
    ?s ${sameAs} ?o .
    << ?s ${sameAs} ?o >> <${ONTOLOGY_NS}indexingRun> "${escapeSparql(input.indexingRunId)}" .
  }
}`.trim());

  const affectedIris = new Set<string>();
  for (const row of affectedData.results?.bindings ?? []) {
    const r = row as unknown as { s: { value: string }; o: { value: string } };
    if (r.s?.value) affectedIris.add(r.s.value);
    if (r.o?.value) affectedIris.add(r.o.value);
  }

  // Delete old canonical markers for affected IRIs before removing the pairs
  if (affectedIris.size > 0) {
    const memberValues = [...affectedIris].map(iri => `<${iri}>`).join(" ");
    await sparqlUpdate(backendUrl, input.datasetId, `
PREFIX ex: <${ONTOLOGY_NS}>
DELETE { GRAPH <${namedGraph}> { ?m ex:isCanonical true } }
WHERE  { GRAPH <${namedGraph}> { VALUES ?m { ${memberValues} } ?m ex:isCanonical true } }`.trim());
  }

  // Delete the sameAs pairs and their provenance annotations
  await sparqlUpdate(
    backendUrl,
    input.datasetId,
    `PREFIX owl: <http://www.w3.org/2002/07/owl#>

DELETE {
  GRAPH <${namedGraph}> {
    ?s ${sameAs} ?o .
    << ?s ${sameAs} ?o >> ?p ?v .
  }
}
WHERE {
  GRAPH <${namedGraph}> {
    ?s ${sameAs} ?o .
    << ?s ${sameAs} ?o >> <${ONTOLOGY_NS}indexingRun> "${escapeSparql(input.indexingRunId)}" .
    OPTIONAL { << ?s ${sameAs} ?o >> ?p ?v }
  }
}`,
  );

  // Re-elect canonicals for clusters that still have surviving members
  if (affectedIris.size > 0) {
    await electAndWriteCanonicals(backendUrl, input.datasetId, affectedIris);
  }
}

// ─── Candidate fetching ───────────────────────────────────────────────────────

/**
 * Returns entities introduced by this specific indexing run, identified via the
 * RDF-star provenance annotation ex:indexingRun on their rdf:type triple.
 */
async function fetchNewEntities(
  backendUrl:    string,
  datasetId:     string,
  indexingRunId: string,
  namedGraph:    string,
): Promise<GraphEntity[]> {
  const sparql = `
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX ex:   <${ONTOLOGY_NS}>

SELECT DISTINCT ?entity ?label ?type ?description WHERE {
  GRAPH <${namedGraph}> {
    ?entity a ?type ;
            rdfs:label ?label .
    << ?entity a ?type >> ex:indexingRun "${escapeSparql(indexingRunId)}" .
    OPTIONAL { ?entity rdfs:comment ?description }
  }
}`.trim();

  const data = await sparqlQuery(backendUrl, datasetId, sparql);
  return toGraphEntities(data.results?.bindings ?? []);
}

/**
 * Fetches top-K candidate entities using the Jena-text Lucene index on rdfs:label.
 * IRIs present in excludeIris (the current run's new entities) are dropped post-fetch.
 */
async function fetchCandidatesByLabel(
  backendUrl:  string,
  datasetId:   string,
  label:       string,
  namedGraph:  string,
  excludeIris: Set<string>,
): Promise<GraphEntity[]> {
  const limit        = PIPELINE_CONSTANTS.normalization.candidateLimit;
  const luceneLabel  = escapeLucene(label);

  const sparql = `
PREFIX text: <http://jena.apache.org/text#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?entity ?label ?type ?description ?score WHERE {
  (?entity ?score) text:query (rdfs:label "${luceneLabel}" ${limit}) .
  GRAPH <${namedGraph}> {
    ?entity rdfs:label ?label .
    OPTIONAL { ?entity a ?type }
    OPTIONAL { ?entity rdfs:comment ?description }
  }
}
ORDER BY DESC(?score)`.trim();

  const data     = await sparqlQuery(backendUrl, datasetId, sparql);
  const entities = toGraphEntities(data.results?.bindings ?? []);
  return entities.filter(e => !excludeIris.has(e.iri));
}

function toGraphEntities(bindings: SparqlBinding[]): GraphEntity[] {
  return bindings
    .map(b => ({
      iri:         b.entity?.value      ?? "",
      label:       b.label?.value       ?? "",
      type:        b.type?.value        ?? "",
      description: b.description?.value ?? "",
    }))
    .filter(e => e.iri !== "" && e.label !== "");
}

// ─── Jaro-Winkler ─────────────────────────────────────────────────────────────

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const matchDist = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches  = new Array<boolean>(a.length).fill(false);
  const bMatches  = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro = (
    matches / a.length +
    matches / b.length +
    (matches - transpositions / 2) / matches
  ) / 3;

  // Winkler prefix bonus: up to 4 common leading chars, scaling 0.1
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] !== b[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Escapes characters with special meaning in Lucene query syntax, producing a
 * string safe to embed inside a SPARQL string literal.
 *
 * Lucene escaping prepends `\` before special chars (e.g. `-` → `\-`).
 * SPARQL string literals treat `\` as an escape prefix, so each Lucene `\`
 * must be doubled to `\\` so the SPARQL parser delivers a single `\` to Lucene.
 *
 * https://lucene.apache.org/core/9_0_0/queryparser/org/apache/lucene/queryparser/classic/package-summary.html
 */
function escapeLucene(value: string): string {
  return value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\\\$&");
}
