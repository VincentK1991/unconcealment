# Phase 3 — Full-Text Search & Entity Normalization
> **Created**: 2026-04-07
> **Status**: Implemented
> **Relates to**: `2026-04-06-phase-implementation.md` §Phase 3B, §Phase 2C

---

## Overview

This runbook documents two completed pieces of work:

1. **Entity normalization pipeline** — a two-phase Temporal activity that detects duplicate entities after each indexing run and asserts `owl:sameAs` links into a dedicated named graph.
2. **Full-text search readiness** — enabling `rdfs:label` on all asserted entities so the Jena-text (Lucene) index that was already configured in `infra/fuseki/config.ttl` is actually populated and usable.

Both pieces are prerequisites for Phase 3B (`POST /query/text`) and Phase 2's reasoned `owl:sameAs` closure.

---

## 1. Full-Text Search Readiness

### What was done

`IngestController.java` now asserts `rdfs:label` for every entity alongside the existing `ex:slug` and `rdfs:comment`:

```java
// rdfs:label — indexed by Jena-text (Lucene) for full-text search and normalization
triples.append("    <").append(entityIri).append("> ")
       .append("<http://www.w3.org/2000/01/rdf-schema#label> ")
       .append("\"").append(escapeSparqlLiteral(entity.label)).append("\" .\n");
```

### Why this was missing

The Fuseki config (`infra/fuseki/config.ttl`) already declared a `text:TextDataset` wrapping both TDB2 datasets, with a Lucene entity map indexing `rdfs:label` and `rdfs:comment`:

```turtle
:entity_map_economic_census
    a text:EntityMap ;
    text:entityField "uri" ;
    text:defaultField "label" ;
    text:map (
        [ text:field "label"   ; text:predicate rdfs:label ]
        [ text:field "comment" ; text:predicate rdfs:comment ]
    ) .
```

But the ingest pipeline only wrote `ex:slug` (lowercased, hyphenated) — not the human-readable `rdfs:label`. Lucene had nothing to index. Every `text:query` would return zero results.

### Effect

- `text:query (rdfs:label "..." N)` via `POST /query/raw` now returns results.
- `rdfs:comment` (entity description) was already being asserted — it is now also indexed.
- No Fuseki config changes required. The index is populated automatically on write.

### Phase 3B wire-up (still pending)

`POST /query/text` in `QueryController.java` is still a stub. When Phase 3B is implemented, wire it to:

```sparql
PREFIX text: <http://jena.apache.org/text#>
SELECT ?entity ?score WHERE {
  (?entity ?score) text:query (rdfs:label "${searchText}" 10)
}
```

POST this via `executeSparqlSelect` to the dataset endpoint. Then do a second hop through `ReasonerService.executeReasoned()` to apply `owl:sameAs` normalization before returning results. Until Phase 3B lands, callers can issue this query directly via `POST /query/raw`.

---

## 2. Entity Normalization Pipeline

### Design decisions

| Decision | Choice | Reason |
|---|---|---|
| Candidate blocking | Jena-text `text:query` top-K | Avoids full graph scan; already configured in Fuseki |
| Type restriction on candidates | None | Cross-type duplicates exist (e.g. `StatisticalMeasure` ≡ `Entity` ≡ `PrivacyFramework`) |
| Comparison scope | New entities vs. all existing | Catches cross-document duplicates |
| Current-run exclusion | Post-fetch IRI set filter | Simpler than SPARQL VALUES block; candidate count is small |
| Phase 1 signal | Jaro-Winkler on normalized labels | Handles abbreviations, punctuation, minor typos |
| Phase 2 signal | Batched LLM structured output | Single call for all medium-confidence pairs; cheaper than per-pair calls |
| LLM context | Label + ontology type + description | Enough for most judgements; avoids over-long prompts |
| sameAs storage | Separate `urn:{datasetId}:normalization` graph | Raw assertions untouched; normalization re-runnable independently |
| Rollback | DELETE by `ex:indexingRun` annotation | Provenance already annotated; no extra bookkeeping |

### Thresholds

Defined in `services/indexing/src/constants/pipeline.ts`:

```typescript
normalization: {
  candidateLimit:          100,   // top-K from Jena-text per new entity
  highConfidenceThreshold: 0.92,  // Jaro-Winkler ≥ this → sameAs, no LLM
  lowConfidenceThreshold:  0.75,  // Jaro-Winkler < this → discard
  llmAcceptThreshold:      0.80,  // LLM confidence ≥ this → accept
}
```

Pairs with Jaro-Winkler in `[0.75, 0.92)` are sent to the LLM. Pairs below `0.75` are discarded entirely.

### Pipeline position

```
uploadSourceDocument
  → resolveDocumentContent
  → embedAndStore
  → Promise.all(chunkIds.map(extractEntitiesFromChunk))   ← fan-out per chunk
  → assertToGraph                                          ← writes to abox:asserted
  → normalizeEntities                                      ← writes to normalization graph
```

### Files changed

| File | Change |
|---|---|
| `services/indexing/src/activities/normalizeEntities.ts` | New activity (see §Implementation detail below) |
| `services/indexing/src/activities/index.ts` | Exports `normalizeEntities`, `deleteNormalization` |
| `services/indexing/src/workflows/indexDocument.ts` | Adds proxy, activity call, rollback leg |
| `services/indexing/src/constants/pipeline.ts` | Adds `normalization` and `models.normalization` blocks |
| `services/backend/.../IngestController.java` | Adds `rdfs:label` assertion |

### Implementation detail

#### Fetching new entities

New entities are identified by the RDF-star provenance annotation written by `assertToGraph`:

```sparql
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX ex:   <https://kg.unconcealment.io/ontology/>

SELECT DISTINCT ?entity ?label ?type ?description WHERE {
  GRAPH <urn:{datasetId}:abox:asserted> {
    ?entity a ?type ;
            rdfs:label ?label .
    << ?entity a ?type >> ex:indexingRun "{indexingRunId}" .
    OPTIONAL { ?entity rdfs:comment ?description }
  }
}
```

This uses Jena 5.x RDF-star quoted triple syntax. It returns exactly the entities introduced by the current workflow run, not re-indexed entities from prior runs.

#### Candidate blocking via Jena-text

For each new entity, top-K candidates are fetched using the Lucene index:

```sparql
PREFIX text: <http://jena.apache.org/text#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?entity ?label ?type ?description ?score WHERE {
  (?entity ?score) text:query (rdfs:label "{escapedLabel}" 100) .
  GRAPH <urn:{datasetId}:abox:asserted> {
    ?entity rdfs:label ?label .
    OPTIONAL { ?entity a ?type }
    OPTIONAL { ?entity rdfs:comment ?description }
  }
}
ORDER BY DESC(?score)
```

The label is escaped for Lucene query syntax before substitution. After fetching, any candidate whose IRI is in the current run's new-entity set is excluded in TypeScript (avoids a new entity matching itself or a sibling from the same run).

#### Phase 1 — Jaro-Winkler scoring

Labels are normalized before scoring: lowercased, non-alphanumeric runs collapsed to a single space.

```
"Apple Inc."   → "apple inc"
"Apple, Inc."  → "apple inc"
```

Jaro-Winkler is computed on the normalized strings. An exact normalized match returns `1.0` and is tagged `normalizationMethod: "exact-label"`. Scores ≥ 0.92 are tagged `"jaro-winkler"`.

#### Phase 2 — LLM judge

All medium-confidence pairs are batched into a single `openai.responses.parse` call using `zodTextFormat`. The prompt:

- Instructs the model to decide whether pairs refer to the same real-world entity
- Explicitly notes that type mismatches alone are not disqualifying (cross-type duplicates exist)
- Instructs the model to be conservative (doubt → `isSameEntity: false`)

Each pair in the prompt:
```
Pair 0:
  Entity A: label="...", type="...", description="..."
  Entity B: label="...", type="...", description="..."
```

Structured output schema:
```typescript
{ judgements: [{ pairIndex: number, isSameEntity: boolean, confidence: number }] }
```

LLM failures in normalization are non-fatal — a `console.warn` is emitted and the phase 2 result is treated as empty. The document is still indexed.

#### Writing owl:sameAs

Accepted pairs (from both phases) are written to `urn:{datasetId}:normalization` in a single SPARQL INSERT DATA via `POST /query/update`:

```sparql
INSERT DATA {
  GRAPH <urn:{datasetId}:normalization> {
    <entityA> owl:sameAs <entityB> .
    << <entityA> owl:sameAs <entityB> >>
      ex:normalizationMethod "exact-label" ;
      ex:confidence          1.0 ;
      ex:indexingRun         "{indexingRunId}" ;
      ex:transactionTime     "{now}"^^xsd:dateTime .
  }
}
```

#### Rollback

The `deleteNormalization` activity DELETEs all `owl:sameAs` triples whose RDF-star annotation carries the current `ex:indexingRun`:

```sparql
DELETE {
  GRAPH <urn:{datasetId}:normalization> {
    ?s owl:sameAs ?o .
    << ?s owl:sameAs ?o >> ?p ?v .
  }
}
WHERE {
  GRAPH <urn:{datasetId}:normalization> {
    ?s owl:sameAs ?o .
    << ?s owl:sameAs ?o >> ex:indexingRun "{indexingRunId}" .
    OPTIONAL { << ?s owl:sameAs ?o >> ?p ?v }
  }
}
```

In the workflow, `deleteNormalization` runs first in the rollback sequence (before `deleteGraphAssertions`) because normalization depends on asserted entities — unwinding in reverse write order.

---

## 3. Integration Checkpoint

```
1. Index a document that mentions "Apple Inc." and "Apple, Inc." in different chunks
   → Temporal UI: normalizeEntities activity completes, sameAsPairsAsserted > 0

2. SPARQL — verify sameAs triples:
   SELECT ?s ?o ?method ?confidence WHERE {
     GRAPH <urn:economic-census:normalization> {
       ?s owl:sameAs ?o .
       << ?s owl:sameAs ?o >> ex:normalizationMethod ?method ;
                              ex:confidence ?confidence .
     }
   }
   → returns the merged pair with method and score

3. SPARQL — verify rdfs:label is indexed:
   PREFIX text: <http://jena.apache.org/text#>
   SELECT ?entity ?score WHERE {
     (?entity ?score) text:query (rdfs:label "apple" 5)
   }
   → returns entity IRIs with Lucene relevance scores

4. Index a second document with a near-duplicate entity (different type, same real-world thing)
   → normalizeEntities phase 2 fires (LLM judge)
   → sameAs triple appears in normalization graph with normalizationMethod="llm-judge"

5. Trigger rollback (e.g. by forcing assertToGraph to fail on a test document)
   → normalization graph has no triples for that indexingRunId after rollback
```

---

## 4. Known Limitations & Future Work

**`POST /query/text` stub** — The dedicated two-hop text search endpoint in `QueryController.java` remains a stub (Phase 3B). Until it is wired, callers must issue `text:query` SPARQL directly via `POST /query/raw`. The normalization activity already does this correctly.

**InfModel not refreshed** — Phase 2 planned a `POST /admin/refresh-model` call after normalization so the `GenericRuleReasoner` picks up the new `owl:sameAs` links. This call is not yet wired in the workflow. Add it after `normalizationDone = true` when `ReasonerService` is implemented.

**LLM batch size** — If a single document introduces many new entities with many medium-confidence pairs, the LLM prompt may grow large. Add a chunk limit (e.g. 50 pairs per call) if this becomes a problem in practice.

**Symmetric sameAs** — Only `A owl:sameAs B` is written, not `B owl:sameAs A`. OWL semantics treat `owl:sameAs` as symmetric, so reasoners handle this correctly. Raw SPARQL queries against the normalization graph without inference may need a `UNION` pattern to cover both directions.
