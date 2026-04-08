# Remaining Implementation Gaps — 2026-04-07

## Confirmed Architecture Decisions

Before the checklist, the following decisions were made explicit on 2026-04-07:

### Reasoning Model (three layers)

1. **`owl:sameAs` normalization** — already materialized into `urn:{datasetId}:abox:normalization` by the normalization pipeline. No additional work needed here; this graph is the source of truth for entity identity.

2. **Forward chaining rules** — must be materialized into `urn:{datasetId}:abox:inferred` at ingestion/load time.
   - Input: `abox:asserted` + `abox:normalization`
   - Engine: Jena `GenericRuleReasoner` in FORWARD mode
   - Rules loaded from `tbox:rules:forward`, ordered by `ex:ruleOrder`, body in `ex:ruleBody`
   - Triggered by `POST /admin/materialize?dataset={id}` and as a final Temporal workflow activity after each document is indexed
   - Implementation class: `MaterializationService` (Java, not yet written)

3. **Backward chaining rules** — applied at query time only, never materialized.
   - Engine: Jena `GenericRuleReasoner` in BACKWARD mode, wrapping asserted + inferred model as InfModel
   - Rules loaded from `tbox:rules:backward`
   - Fires when `/query/reasoned` is called; forward-derived facts in `abox:inferred` must be visible to the backward reasoner

### Cross-dataset normalization
Deferred. Normalization stays per-dataset. Cross-dataset `owl:sameAs` (e.g., county in economic-census ≡ county in public-health) is a later phase.

### BigQuery binding format
Keep YAML + LLM-generates-SQL at runtime. R2RML Turtle migration is deferred. No programmatic SPARQL-to-SQL translation planned yet.

### MVP definition
Entity browser working: index documents → browse entities in web UI → see provenance. Requires Phase 2 reasoner to resolve `owl:sameAs` in entity pages.

---

## Phase 2A — Reasoning Engine (MVP Blocker)

Everything in this section is blocking the entity browser. Nothing downstream works without the reasoner.

### 2A-1 · Implement `MaterializationService` (Java)

**File to create**: `backend/src/main/java/.../service/MaterializationService.java`

Steps:
1. Query `urn:{datasetId}:tbox:rules:forward` for all `ex:ForwardRule` nodes, sorted by `ex:ruleOrder`
2. Collect each `ex:ruleBody` literal string
3. Parse via `Rule.parseRule()` (Jena `org.apache.jena.reasoner.rulesys.Rule`)
4. Build `GenericRuleReasoner` in FORWARD mode
5. Load `abox:asserted` + `abox:normalization` named graphs into an in-memory `Model`
6. Run forward closure; collect inferred triples
7. Wipe `abox:inferred` (SPARQL `CLEAR GRAPH`) then INSERT inferred triples in batches

**Peculiarity**: `owl:sameAs` symmetry and transitivity rules in `forward.ttl` must fire over pairs already in `abox:normalization`. Make sure both graphs are unioned as input to the reasoner — do not pass `abox:asserted` alone.

### 2A-2 · Add `POST /admin/materialize?dataset={id}` endpoint

**File**: `backend/src/main/java/.../controller/AdminController.java`

Calls `MaterializationService.materialize(datasetId)`. Returns 200 with triple count delta. Returns 409 if a materialization is already in progress (add a per-dataset lock).

### 2A-3 · Wire materialization as final Temporal activity

**File**: `indexing/src/workflows/indexingWorkflow.ts`

After `normalizeEntitiesLlm`, add a final activity `triggerMaterialization` that calls `POST /admin/materialize?dataset={id}`. Add compensation (rollback) logic: on failure, log warning but do not fail the workflow — stale inferred graph is recoverable; losing the whole workflow is not.

### 2A-4 · Fix `/query/reasoned` to actually use `abox:inferred` — PARTIALLY DONE 2026-04-07

**File**: `backend/src/main/java/.../controller/QueryController.java`

#### What is implemented now

`/query/reasoned` builds an in-memory InfModel from the **normalization graph only** (24 triples: `owl:sameAs` pairs + `ex:isCanonical` markers), then applies a `GenericRuleReasoner` in **HYBRID mode** with:

- **Forward rules loaded** (maxOrder ≤ 30 only):
  - `sameAsSymm` (order 20): `(?a owl:sameAs ?b) → (?b owl:sameAs ?a)`
  - `sameAsTrans` (order 30): `(?a owl:sameAs ?b), (?b owl:sameAs ?c) → (?a owl:sameAs ?c)`
- **Backward rules loaded** (all):
  - `canonicalResolution`: derives `ex:hasProperty` on canonical from aliases
  - `indicatorRegion`: derives `ex:inRegion` on indicators from source document

The InfModel closes the `owl:sameAs` graph bidirectionally and transitively. It can be queried with SPARQL (no GRAPH clauses — no named graphs in InfModel).

#### What the entity page "With sameAs" tab actually uses

The entity page **does NOT call `/query/reasoned`** for the tab. It calls `/query/raw` with a **SPARQL 1.1 property path** query:

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT DISTINCT ?source ?p ?o WHERE {
  GRAPH <urn:{datasetId}:normalization> {
    <entityIri> (owl:sameAs|^owl:sameAs)+ ?source .
    FILTER(?source != <entityIri>)
  }
  GRAPH <urn:{datasetId}:abox:asserted> {
    ?source ?p ?o . FILTER(isIRI(?source))
  }
  FILTER(?p != owl:sameAs)
}
```

Fuseki's native SPARQL engine handles the `(owl:sameAs|^owl:sameAs)+` path (transitive + bidirectional), returning all cluster-member properties with a `?source` column identifying which peer entity each triple came from.

#### Why the InfModel approach was not used for the tab

Two blockers discovered during implementation:

1. **RDF-star parse error** (`[L_TRIPLE]`): `conn.fetch(graphUri)` downloads the named graph as Turtle via GSP. The `abox:asserted` and `normalization` graphs contain RDF-star reification triples (`_:b rdf:reifies <<...>>`). The Jena GSP client uses the Turtle 1.1 parser which cannot parse `<<...>>` triple-term objects → `RiotException`. **Workaround applied**: use `CONSTRUCT { ?s ?p ?o } WHERE { FILTER(isIRI(?s)) }` via Fuseki instead of `conn.fetch()`. This skips blank-node reification subjects (which carry the triple-term objects) and returns only regular entity triples.

2. **OOM from forward property propagation**: Loading 554 abox triples into a `GenericRuleReasoner` in HYBRID mode and running `sameAsPropFwd`/`sameAsPropBwd` (orders 40/50) causes `OutOfMemoryError: Java heap space`. These rules copy every property of every entity to every sameAs peer — quadratic expansion. **Workaround applied**: cap forward rules at maxOrder=30 (symmetry + transitivity only). Property propagation is excluded from InfModel; the Astro page fetches peer properties explicitly via SPARQL property paths.

#### What is still missing

1. **`abox:asserted` is not in the InfModel** — `/query/reasoned` only sees the normalization graph. Any query asking for entity properties (e.g., `?e ex:label ?l`) returns nothing. The endpoint is only useful for `owl:sameAs`-pattern queries against the normalization graph.

2. **`abox:inferred` is not included** — `MaterializationService` (2A-1) has not been implemented, so `abox:inferred` is empty. Even once it exists, loading it into the InfModel requires the RDF-star workaround (CONSTRUCT instead of fetch).

3. **Backward rules are loaded but never fire** — `canonicalResolution` uses `ex:hasProperty` which does not exist in any data. `indicatorRegion` uses `ex:inRegion` which is also absent. Neither rule will produce results until data with those predicates is indexed, or the rule bodies are updated to use actual ontology predicates.

4. **Named graph semantics lost** — InfModel has no named graphs. Any caller using `GRAPH` clauses gets no results. The entity page works around this by using `/query/raw` for anything requiring GRAPH scoping.

#### Target behavior (still to implement)

To fully implement 2A-4:
1. Solve the RDF-star GSP fetch problem at the Jena client level (or configure Fuseki to return N-Triples/JSON-LD instead of Turtle for GSP fetches, which avoids the `<<...>>` syntax).
2. Load `abox:asserted` + `abox:normalization` + `abox:inferred` into the InfModel using the CONSTRUCT workaround.
3. Apply backward rules only (BACKWARD mode, not HYBRID) so forward property propagation never runs at query time.
4. Wire property-lookup queries to go through this InfModel so `?e ?p ?o` patterns resolve with backward-rule inferences included.

### 2A-5 · Add `POST /admin/refresh-model?dataset={id}` endpoint

Hot-reload: calls `OntologyLoaderService.reload(datasetId)` then `MaterializationService.materialize(datasetId)`. Useful after ontology/rules edits without full restart.

### 2A-6 · Verify forward rules fire correctly

Write integration tests (or manual SPARQL queries) confirming:
- `sameAs` symmetry: insert A owl:sameAs B → query finds B owl:sameAs A in `abox:inferred`
- `sameAs` transitivity: A sameAs B, B sameAs C → A sameAs C in `abox:inferred`
- `partOf` transitivity: tract partOf county, county partOf state → tract partOf state in `abox:inferred`
- `rdfs:subClassOf` propagation: entity typed as subclass inherits superclass type

---

## Phase 2B — Entity Browser UI (MVP Blocker)

### 2B-1 · Wire entity page to `/query/reasoned`

**File**: `services/web/src/pages/entity/[uuid].astro`

Change the SPARQL query call from `/query/raw` to `/query/reasoned` so canonical entity resolution via `owl:sameAs` closure applies.

### 2B-2 · Implement provenance viewer React component

**File**: `services/web/src/components/ProvenanceTable.tsx` (create)

Query: `SELECT ?p ?o ?method ?confidence ?sourceDoc ?txTime WHERE { << <{entityIri}> ?p ?o >> ex:extractionMethod ?method ; ex:confidence ?confidence ; ex:sourceDocument ?sourceDoc ; ex:transactionTime ?txTime . }`

Render as a table with columns: predicate, object, confidence, extraction method, source document, transaction time.

**Peculiarity**: Jena 5.x serializes RDF-star triple terms as nested JSON objects in SPARQL JSON results. The shape is `{"type": "triple", "value": {"subject": ..., "predicate": ..., "object": ...}}`. Confirm that `backend.ts` result parsing handles this nested structure — it likely does not yet.

### 2B-3 · Wire ontology browser page

**File**: `services/web/src/pages/dataset/[id]/ontology.astro`

Currently calls a stub. Wire to `POST /query/tbox` with a SPARQL query selecting all `owl:Class` and `owl:ObjectProperty` / `owl:DatatypeProperty` from `urn:{datasetId}:tbox:ontology`.

### 2B-4 · Implement slug routing

**File**: `services/web/src/pages/entity/[slug].astro` (create)

Query `abox:asserted` for `?entity ex:slug "{slug}"`. If found, return 301 redirect to `/entity/{uuid}`. If not found, 404.

---

## Phase 2C — Normalization Completeness

### 2C-1 · ~~Verify Jena-text Lucene index is populated~~ FIXED 2026-04-07

**Root cause identified and fixed**: `infra/fuseki/config.ttl` entity maps had no `text:graphField`. Jena-text only indexed the default graph. All entity data lives in named graphs (`abox:asserted`). Default graph was empty → Lucene index was empty → `text:query` returned 0 candidates → normalization produced 0 pairs every run.

**Fix applied**: Added `text:graphField "graph"` to both `:entity_map_economic_census` and `:entity_map_public_health` in `config.ttl`.

**Required action after deploy**: Restart Fuseki (or call the Jena-text rebuild endpoint) so the existing TDB2 triples are re-indexed into Lucene under the new named-graph-aware schema. Until Fuseki restarts, the old empty index is still in use.

### 2C-2 · Add normalization telemetry output

**File**: `indexing/src/activities/normalizeEntitiesRuleBased.ts`

Return stats from the activity:
```typescript
{
  totalEntities: number,
  exactMatches: number,
  highConfidenceMatches: number,  // jaro-winkler >= 0.92, auto sameAs
  sentToLlm: number,              // 0.75–0.92
  llmAccepted: number,
  llmRejected: number,
  noCandidate: number,
}
```
Log these in the workflow so threshold tuning is data-driven.

### 2C-3 · Intra-batch entity deduplication

**File**: `indexing/src/activities/normalizeEntitiesRuleBased.ts`

Current gap: two entities extracted from the same document batch that are duplicates of each other are not caught until a second indexing run looks them up against existing graph entities.

Add a pre-pass before the Jaro-Winkler graph lookup: within the batch of new entity IRIs, compute pairwise Jaro-Winkler on normalized labels. Flag pairs above the high-confidence threshold as `owl:sameAs` candidates before ever touching the graph. This eliminates most same-document duplicates.

**Note**: Only needed when a single document produces multiple extracted entities with similar labels (e.g., "Cook County" and "cook county" extracted as separate entities from the same chunk).

### 2C-4 · Add entity type context to LLM normalization prompt

**File**: `indexing/src/activities/normalizeEntitiesLlm.ts`

The LLM judge currently sees label strings only. Add `rdf:type` for each entity in the prompt pair. Example: "Entity A: 'Memorial Hospital' (type: ex:Hospital)" vs "Entity B: 'Memorial Hospital' (type: ex:HealthIndicator)". This reduces false positives where differently-typed entities share a label.

### 2C-5 · Test slug collision handling under load

**File**: `backend/src/main/java/.../controller/IngestController.java`

The counter-suffix collision detection logic exists but has no test coverage. Write a test that mints two entities whose labels produce the same base slug and assert the second gets a `-2` suffix. Check the suffix increment is atomic (thread-safe under concurrent indexing).

---

## Phase 3A — Full-Text Search Endpoint

Infrastructure is already in place (Jena-text Lucene configured in `infra/fuseki/config.ttl`, candidate blocking in normalization already uses it).

### 3A-1 · Implement `POST /query/text?dataset={id}`

**File**: `backend/src/main/java/.../controller/QueryController.java`

Steps:
1. Execute `SELECT ?entity WHERE { ?entity text:query (rdfs:label "{q}" 100) }` → candidate IRIs
2. For each IRI, resolve canonical entity: query `abox:normalization` + `abox:inferred` for `owl:sameAs` closure, return the canonical IRI (lowest-sort or designated primary)
3. Return canonical entity set with Lucene relevance scores

Currently returns 501 Not Implemented.

---

## Phase 3B — BigQuery Binding Verification

R2RML Turtle migration is deferred. Keep YAML + LLM SQL. But verify the current path is actually wired:

### 3B-1 · Confirm YAML binding is fed to LLM at query time

Trace the query path end-to-end: where does `bigquery-bindings.yaml` get read? Where is its content injected into the LLM prompt? If this path is stubbed, document exactly what still needs wiring.

### 3B-2 · Implement or verify `POST /query/bigquery` endpoint

If this endpoint exists, test it with a natural language query against a known BigQuery table. If it does not exist, implement: read binding YAML → build LLM prompt with table schema + binding context → generate SQL → execute against BigQuery → return results.

---

## Phase 4 — Observability & Admin

Lower priority; not MVP-blocking.

### 4A · Triple count Prometheus metrics

Add Micrometer gauges that periodically query each named graph for triple count:
```sparql
SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:{datasetId}:abox:asserted> { ?s ?p ?o } }
```
Expose via Spring Boot Actuator `/actuator/prometheus`.

### 4B · Admin dashboard `/admin` page

Buttons: Reload Ontology, Re-run Materialization, Re-run Normalization — one per dataset. Wire to `/admin/reload`, `/admin/materialize`, and a new `/admin/normalize?dataset={id}` endpoint.

### 4C · Content negotiation on entity IRIs

In `/entity/[uuid].astro`, inspect `Accept` header:
- `text/html` → render Astro page (current behavior)
- `application/ld+json` → serialize entity triples as JSON-LD, return directly
- `text/turtle` → serialize as Turtle, return directly

Makes entity IRIs dereferenceable by semantic web clients.

---

## Peculiarities & Potential Improvements

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | Forward rules are dormant — materialization never triggered | **Critical** | MaterializationService does not exist; nothing calls it |
| 2 | `/query/reasoned` InfModel covers normalization graph only | **High** | abox:asserted not loaded due to RDF-star GSP parse error + OOM from forward property propagation; see 2A-4 for full gap analysis |
| 3 | Backward rules loaded but never fire | **Medium** | canonicalResolution uses ex:hasProperty, indicatorRegion uses ex:inRegion — neither predicate exists in current data |
| 4 | Re-materialization not triggered after indexing | **Critical** | abox:inferred goes stale after every new document until someone manually calls /admin/materialize |
| 5 | ~~Jena-text index didn't cover named graphs~~ | **FIXED** | `text:graphField "graph"` added to both entity maps in config.ttl; Fuseki restart required |
| 6 | Intra-batch entity deduplication missing | **Medium** | Same-document duplicate entities survive until a second indexing run |
| 7 | RDF-star JSON parsing in frontend untested against real Jena output | **Medium** | Jena 5.x nested triple term format may not be handled by frontend result parser |
| 8 | BigQuery binding wiring status unclear | **Medium** | Design complete; unclear if YAML is actually fed to LLM in any live code path |
| 9 | LLM normalization judge has no entity type context | **Low** | Easy improvement: pass rdf:type in prompt to reduce false positives |
| 10 | Slug collision handling untested | **Low** | Counter-suffix logic exists but no test; may have race condition under concurrent ingest |

---

## Priority Order for MVP

1. `MaterializationService` + `/admin/materialize` endpoint (2A-1, 2A-2)
2. Wire materialization as final Temporal activity (2A-3)
3. Fully implement `/query/reasoned` with abox:asserted in InfModel (2A-4) — blocked on RDF-star GSP issue; current workaround (SPARQL property paths) handles sameAs tab
4. Verify Jena-text Lucene index populated (2C-1)
5. Wire entity browser to `/query/reasoned` for backward rule inference (2B-1) — sameAs tab already works via property paths
6. Implement provenance viewer component (2B-2) — fix RDF-star JSON parsing first
7. Implement full-text search endpoint (3A-1)

### What is working as of 2026-04-07

- **Entity page "Without sameAs" tab**: asserted + forward-materialized triples via `/query/raw`
- **Entity page "With sameAs" tab**: cluster peer properties via SPARQL 1.1 `(owl:sameAs|^owl:sameAs)+` property path against Fuseki (`/query/raw`); source column identifies which peer entity each triple came from
- **Canonical banner**: non-canonical entity pages show a banner linking to the canonical representative
- **`/query/reasoned`**: builds InfModel from normalization graph (24 triples) with sameAs symmetry+transitivity rules; backward rules are wired but do not fire on current data

Items 1–4 are the critical path. The normalization pipeline is well-implemented; the bottleneck is that its output is never consumed by the query layer.
