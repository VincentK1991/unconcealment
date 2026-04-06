# Phased Implementation Plan
> **Created**: 2026-04-06  
> **Status**: Active  
> **Stack**: Apache Jena Fuseki · Spring Boot Java · TypeScript Temporal · React/Astro · PostgreSQL + pgvector

---

## Orientation: What the Stubs Are Actually Doing

Before the phases, here is the precise gap between what exists and what runs:

- **Backend**: `JenaConfig` opens `RDFConnectionRemote` connections per dataset but does not load TTL files into named graphs, does not build any `InfModel`, and all four `QueryController` endpoints return stubs. The connection map is wired, but nothing uses it.
- **Indexing**: `embedAndStore` has chunking + OpenAI embeddings + raw Prisma insert structure. `extractEntities` calls GPT-4o but feeds a placeholder string as ontology context instead of a live SPARQL query. `assertToGraph` builds correct RDF-star SPARQL UPDATE strings but only logs them — never POSTs to the backend.
- **Web**: `index.astro` reads manifest and renders dataset cards. `[uuid].astro` constructs entity IRI and calls backend but the backend returns a stub. `backend.ts` is fully wired client-side but the backend behind it does nothing.
- **Fuseki/Infra**: Fuseki config declares both datasets with TDB2 + Lucene text index. Docker Compose is complete. Postgres pgvector init is done. Temporal is configured.

---

## Phase 1 — End-to-End Indexing (MVP)

**Goal**: One document goes in through Temporal and its triples are readable from the web UI entity page. No reasoning yet — raw graph only.

### 1A: Java Backend — Named Graph Loader + Raw SPARQL Gateway

**`services/backend/src/main/java/com/unconcealment/backend/config/JenaConfig.java`**

Replace the stub with a full startup loader. For each dataset in the manifest:

1. Keep the existing `RDFConnectionRemote` to the Fuseki SPARQL endpoint.
2. Add a second `RDFConnectionRemote` for the Fuseki UPDATE endpoint (`/{dataset}/update`).
3. Load each TTL file using `RDFDataMgr.loadModel(path)` in the backend JVM, then `conn.load(namedGraphUri, model)` via `RDFConnection` — this does an HTTP PUT to Fuseki's graph store protocol (`/data?graph=...`). **Do not use Fuseki's `LOAD <file:///...>` command** — that requires filesystem co-location with Fuseki which breaks in Docker topology.

Named graphs to load per dataset:
- `urn:{datasetId}:tbox:ontology` ← `ontologyPath`
- `urn:{datasetId}:tbox:rules:forward` ← `rules.forward`
- `urn:{datasetId}:tbox:rules:backward` ← `rules.backward`

All graph URIs come from manifest — nothing hardcoded.

---

**`services/backend/src/main/java/com/unconcealment/backend/service/OntologyLoaderService.java`** *(new)*

Extract TTL loading into a service independent of `JenaConfig` so it can be re-triggered by `POST /admin/reload` without a restart. This service:
- Takes the manifest and loads each ontology/rules/bindings file via `RDFDataMgr` + `conn.load()`
- Logs a load event to `urn:{datasetId}:system:health` via SPARQL INSERT after each successful load

---

**`services/backend/src/main/java/com/unconcealment/backend/controller/QueryController.java`**

| Endpoint | Implementation |
|---|---|
| `POST /query/raw` | Wire to `QueryExecutionHTTP` against the dataset's Fuseki SPARQL endpoint. Serialize results via `ResultSetFormatter.outputAsJSON()`. |
| `POST /query/tbox` | Same as `queryRaw` but prepend `FROM <urn:{datasetId}:tbox:ontology> FROM <urn:{datasetId}:tbox:rules:forward> FROM <urn:{datasetId}:tbox:rules:backward>` to restrict scope. Parse and rewrite the SPARQL string to inject these clauses. |
| `POST /query/update` *(add new)* | Accepts SPARQL UPDATE body. Routes via `UpdateExecutionHTTP` to `{fusekiUrl}/{dataset}/update`. Returns `{ status: "ok" }`. This is what `assertToGraph.ts` will POST to. |
| `POST /query/reasoned` | Point at `queryRaw` for now. Document with a `// Phase 2: replace with InfModel` comment. |
| `POST /query/text` | Leave as stub — Phase 3. |

Result serialization: `ResultSetFormatter.outputAsJSON()` writes to a `ByteArrayOutputStream`. Parse to `Map<String, Object>` via Jackson. The web UI already expects `{ results: { bindings: [...] } }` SPARQL JSON format.

---

### 1B: Indexing Pipeline — Wire the Three TODOs

**`services/indexing/src/activities/extractEntities.ts`**

Replace the placeholder `ontologyContext` string with a live SPARQL query:

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?class ?label ?comment WHERE {
  ?class a owl:Class ; rdfs:label ?label .
  OPTIONAL { ?class rdfs:comment ?comment }
}
```

POST to `POST /query/tbox?dataset={datasetId}`. Serialize the result rows into a compact text block and prepend to the GPT-4o system prompt. Add a retry on Zod parse failure that injects the error message into a follow-up GPT-4o prompt.

---

**`services/indexing/src/activities/assertToGraph.ts`**

Replace the `console.log` with a real `fetch` POST to `${backendUrl}/query/update?dataset=${input.datasetId}`. The RDF-star SPARQL UPDATE string is already correct — Jena 5.x + Fuseki 5.5.0 both support `<< s p o >> prov-pred prov-obj` natively. No library changes needed.

---

**`services/indexing/src/activities/embedAndStore.ts`**

Fix the pgvector insert. Prisma's parameterized binding will cast the vector string as `text`, not `vector`, causing a type error. The correct pattern:

```typescript
await prisma.$queryRaw<Array<{ id: string }>>(
  Prisma.sql`
    INSERT INTO document_chunks (document_iri, dataset_id, chunk_text, chunk_index, embedding, source_url)
    VALUES (${documentIri}, ${datasetId}, ${chunk}, ${i},
            ${Prisma.raw(`'[${vector.join(",")}]'::vector`)}, ${sourceUrl})
    RETURNING id::text
  `
)
```

Use `Prisma.raw()` to inline the `::vector` cast. This is a known limitation in the Prisma pgvector integration.

Also run `prisma migrate dev --name init` to apply the schema to the running Postgres instance before testing.

---

**`services/indexing/src/scripts/triggerDocument.ts`** *(new)*

Integration test harness. Reads a test document, mints a document IRI, and calls:

```typescript
temporalClient.workflow.start('indexDocument', {
  taskQueue: 'indexing',
  args: [{ datasetId, documentIri, text, sourceUrl }]
})
```

Use this to manually fire the first end-to-end run and verify the full pipeline.

---

### 1C: Web UI — Dataset Browse Page

**`services/web/src/pages/dataset/[id].astro`** *(new)*

The `index.astro` dataset cards link to `/dataset/{id}` but the page does not exist. Create it:

```sparql
SELECT ?entity ?label ?type WHERE {
  GRAPH <urn:{datasetId}:abox:asserted> {
    ?entity a ?type ; rdfs:label ?label
  }
}
ORDER BY DESC(?entity)
LIMIT 20
```

Call `POST /query/raw?dataset={id}`. Render as a table linking to `/entity/{uuid}?dataset={id}`. The `[uuid].astro` page already exists and will work once `queryReasoned` routes to `queryRaw`.

---

### Phase 1 Integration Checkpoint

```
1. docker compose up                          → Fuseki, Temporal, Postgres healthy
2. cd services/backend && ./mvnw spring-boot:run
                                              → logs show TTL loaded into named graphs
3. GET /health/ready                          → { fusekiReachable: true }
4. Fuseki UI: SELECT * FROM <urn:economic-census:tbox:ontology> WHERE { ?s ?p ?o } LIMIT 5
                                              → returns ontology triples
5. cd services/indexing && npm run worker     → Temporal worker starts
6. ts-node src/scripts/triggerDocument.ts     → workflow starts
7. Temporal UI at :8088                       → all three activities complete
8. GET http://localhost:4321/dataset/economic-census
                                              → entity appears in list
9. Click entity link                          → entity page renders triples
```

---

## Phase 2 — Hybrid Reasoning + Provenance Viewer

**Goal**: `/query/reasoned` runs the real `GenericRuleReasoner` in HYBRID mode. Entity pages show RDF-star provenance. `owl:sameAs` normalization pipeline wired.

### Core Architecture Decision: InfModel Caching

`GenericRuleReasoner` operates on in-memory `Model`, not on a remote TDB2/Fuseki store. The strategy:

- **Build and cache `InfModel` as a Spring singleton at startup**: load ABox via `RDFDataMgr` stream from Fuseki into an in-memory `Model`, wrap with `GenericRuleReasoner` in HYBRID mode.
- **Refresh via `POST /admin/refresh-model?dataset={id}`**: the indexing worker calls this endpoint after each `assertToGraph` completes.
- Stale InfModel between writes is acceptable in Phase 2. Phase 4 can add reactive refresh.

---

**`services/backend/src/main/java/com/unconcealment/backend/service/ReasonerService.java`** *(new)*

Startup sequence per dataset:
1. Query `urn:{datasetId}:tbox:rules:forward` and `urn:{datasetId}:tbox:rules:backward` for `ex:ruleBody` literals in `ex:ruleOrder` sequence.
2. Parse each body string via `Rule.parseRule(ruleBodyString)`.
3. Build `GenericRuleReasoner`:
   ```java
   GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
   reasoner.setMode(GenericRuleReasoner.HYBRID);
   ```
4. Load ABox model: CONSTRUCT from Fuseki `urn:{datasetId}:abox:asserted` + `urn:{datasetId}:normalization` into an in-memory `Model`.
5. Create `InfModel infModel = ModelFactory.createInfModel(reasoner, baseModel)`.
6. Cache in a `Map<String, InfModel>` bean.

For `executeReasoned(datasetId, sparql)`: run `QueryExecutionFactory.create(QueryFactory.create(sparql), infModel)`.

---

**`services/backend/src/main/java/com/unconcealment/backend/controller/QueryController.java`**

Wire `queryReasoned` to `ReasonerService.executeReasoned()`. Add `POST /admin/refresh-model?dataset={id}` that rebuilds the InfModel for the dataset.

---

### 2B: Provenance Viewer in Web UI

**`services/web/src/pages/entity/[uuid].astro`** (modify)

Add a provenance section. Use RDF-star query syntax:

```sparql
PREFIX ex: <https://kg.unconcealment.io/ontology/>
SELECT ?s ?p ?o ?sourceDoc ?confidence ?extractedAt WHERE {
  GRAPH <urn:{datasetId}:abox:asserted> {
    << ?s ?p ?o >>
      ex:sourceDocument ?sourceDoc ;
      ex:confidence ?confidence ;
      ex:extractedAt ?extractedAt .
  }
  FILTER(?s = <{entityIri}>)
}
```

Call `POST /query/raw?dataset={id}` (provenance is raw, no inference needed).

**`services/web/src/components/ProvenanceTable.tsx`** *(new)*

React island component. Accepts provenance rows and renders as a collapsible table showing predicate, object, confidence score, extraction method, and source document link. Toggled by a "Show provenance" button on the entity page.

---

### 2C: owl:sameAs Normalization Pipeline

**`services/indexing/src/activities/normalizeEntity.ts`** *(new)*

Multi-tier normalization called after `assertToGraph` for each new entity IRI:

- **Tier 1 (rule-based)**: fetch `rdfs:label` of the new entity and all existing entities of the same `rdf:type` via `POST /query/raw`. Compute normalized edit distance. If score > 0.85, assert `owl:sameAs` directly.
- **Tier 2 (LLM judge)**: if Tier 1 score falls below threshold, POST both entity descriptions to GPT-4o and request a binary same/different judgment with reasoning.

Both tiers write `owl:sameAs` to `urn:{datasetId}:normalization` via `POST /query/update` with RDF-star provenance on the link:
```sparql
INSERT DATA {
  GRAPH <urn:{datasetId}:normalization> {
    << <{entityA}> owl:sameAs <{entityB}> >>
      ex:normalizationMethod "{method}" ;
      ex:confidence {score} ;
      ex:transactionTime "{now}"^^xsd:dateTime .
    <{entityA}> owl:sameAs <{entityB}> .
  }
}
```

**`services/indexing/src/workflows/indexDocument.ts`** (modify)

Add `normalizeEntity` as step 4. Only trigger when `assertToGraph` created at least one new entity IRI (not previously in the graph). After normalization, call `POST /admin/refresh-model?dataset={id}` to refresh the InfModel.

---

### Phase 2 Integration Checkpoint

```
1. POST /query/reasoned with a SPARQL query using subClassOf traversal
                                        → inferred triples appear (e.g. County → GeographicArea)
2. Assert two entities with owl:sameAs manually via Fuseki UI
   POST /query/reasoned for one         → returns merged triple set from both
3. Index a second document with a near-duplicate entity label
                                        → Temporal workflow fires normalizeEntity
4. Entity page at /entity/{uuid}        → provenance table visible, confidence scores shown
```

---

## Phase 3 — Semantic Binding Layer + Full-Text Search + Ontology Browser

**Goal**: BigQuery bindings are loaded as RDF triples. Jena-text full-text search wired. Web UI has search + ontology browser + content negotiation.

### 3A: Migrate YAML Bindings to Turtle

**`ontology/economic-census/bindings.ttl`** *(new — replaces `bigquery-bindings.yaml`)*

Migrate using the R2RML + custom `ex:` annotation vocabulary defined in `docs/decisions/semantic-binding.md`. Mapping table:

| YAML field | Turtle equivalent |
|---|---|
| `id` | `<#TableId>` local IRI fragment |
| `dataset` + `table` | `rr:logicalTable [ rr:sqlQuery "SELECT ... FROM \`project.dataset.table\`" ]` |
| `description` | `rdfs:comment` on `rr:TriplesMap` |
| `rdfBinding.entityClass` | `rr:subjectMap [ rr:class <entityClass> ]` |
| `rdfBinding.joinExpression` | `ex:joinExpression` custom annotation |
| `keyColumns[].name` | `rr:predicateObjectMap [ rr:objectMap [ rr:column "name" ] ]` |
| `queryExamples[].intent` | `rdfs:label` on `ex:QueryExample` instance |
| `queryExamples[].sql` | `ex:sql` on `ex:QueryExample` instance |

**`ontology/public-health/bindings.ttl`** *(new — replaces `bigquery-bindings.yaml`)*

Same pattern for the public-health dataset.

---

**`ontology/manifest.yaml`** (modify)

**Must update Java + TypeScript parsers atomically with this change or startup fails silently.**

```yaml
# Before
bigquery:
  enabled: true
  bindingsPath: ontology/economic-census/bigquery-bindings.yaml

# After
bindingsPath: ontology/economic-census/bindings.ttl
```

**`services/backend/src/main/java/com/unconcealment/backend/model/DatasetManifest.java`** (modify)

Add `private String bindingsPath;` to `DatasetConfig`. Add `NamedGraphs.bindings()` returning `"urn:" + datasetId + ":bindings"`.

**`services/indexing/src/config/manifest.ts`** (modify)

Add `bindingsPath?: string` to `DatasetConfig` type. Add `namedGraphs().bindings` to the graph URI helper.

**`OntologyLoaderService.java`** (modify)

Load `bindings.ttl` into `urn:{datasetId}:bindings` at startup alongside ontology and rules.

---

### 3B: Full-Text Search

**`services/backend/src/main/java/com/unconcealment/backend/controller/QueryController.java`** (modify)

Wire `queryText`. Fuseki's Jena-text index is already configured in the Fuseki `config.ttl` (Lucene indexing `rdfs:label` and `rdfs:comment`). Two-hop pattern:

**Hop 1** — text query against the Fuseki text-enabled dataset endpoint:
```sparql
PREFIX text: <http://jena.apache.org/text#>
SELECT ?entity ?score WHERE {
  (?entity ?score) text:query (rdfs:label "{searchText}" 10)
}
```

**Hop 2** — for each candidate IRI, resolve via `ReasonerService.executeReasoned()` to apply `owl:sameAs` normalization. Return the canonical entity set.

---

### 3C: Web UI

**`services/web/src/pages/search.astro`** *(new)*

Search form that calls `POST /query/text?dataset={id}` via `backend.ts`. Renders results as entity cards (label, type, IRI, confidence score from text index).

**`services/web/src/pages/ontology/[datasetId].astro`** *(new)*

Ontology browser. Query `POST /query/tbox?dataset={id}` for classes and properties:

```sparql
SELECT ?class ?label ?parent ?comment WHERE {
  ?class a owl:Class ; rdfs:label ?label .
  OPTIONAL { ?class rdfs:subClassOf ?parent }
  OPTIONAL { ?class rdfs:comment ?comment }
}
```

Render as an expandable class hierarchy. Each class links to a `/dataset/{id}?type={class}` instance listing.

**`services/web/src/pages/entity/[uuid].astro`** (modify)

Add `Accept` header content negotiation for machine clients:

```typescript
const accept = Astro.request.headers.get('accept') ?? '';
if (accept.includes('application/ld+json')) {
  // fetch all triples, serialize to JSON-LD
  return new Response(JSON.stringify(jsonLd), {
    headers: { 'Content-Type': 'application/ld+json' }
  });
}
if (accept.includes('text/turtle')) {
  return new Response(turtleString, {
    headers: { 'Content-Type': 'text/turtle' }
  });
}
// else fall through to normal HTML render
```

The canonical IRI is now dereferenceable: same URL serves humans (HTML), LLMs (JSON-LD), and SPARQL clients (Turtle).

---

### Phase 3 Integration Checkpoint

```
1. SELECT * FROM <urn:economic-census:bindings> WHERE { ?s a rr:TriplesMap }
                                        → returns TriplesMap resources
2. POST /query/text?dataset=economic-census with body "county"
                                        → returns entity IRIs with scores
3. Navigate to /ontology/economic-census → class hierarchy renders
4. curl -H "Accept: application/ld+json" http://localhost:4321/entity/{uuid}
                                        → returns JSON-LD response body
5. POST /query/tbox with the SPARQL from docs/decisions/semantic-binding.md §7
                                        → returns full binding context with query examples
```

---

## Phase 4 — Observability, Forward-Chaining Materialization, Admin UX

**Goal**: Triple counts per named graph in health endpoints. Forward-chaining materialization into `abox:inferred`. Admin page for operational control.

### 4A: Health Metrics — Triple Counts

**`services/backend/src/main/java/com/unconcealment/backend/controller/HealthController.java`** (modify)

For `GET /health/metrics`, query Fuseki for triple counts per named graph:

```sparql
SELECT ?graph (COUNT(*) AS ?count) WHERE {
  GRAPH ?graph { ?s ?p ?o }
}
GROUP BY ?graph
```

Register each count as a Micrometer `Gauge` metric tagged with `dataset` and `graph` labels. Expose via `GET /actuator/prometheus` as `kg_triple_count{dataset="economic-census",graph="abox:asserted"}`.

For `GET /health/ready`, issue an ASK query to each dataset endpoint:
```sparql
ASK { ?s ?p ?o } LIMIT 1
```
Wrap in try/catch with a 3-second timeout.

---

### 4B: Forward-Chaining Materialization

**`services/backend/src/main/java/com/unconcealment/backend/service/MaterializationService.java`** *(new)*

Called via `POST /admin/materialize?dataset={id}`:

1. `DROP GRAPH <urn:{datasetId}:abox:inferred>` via SPARQL UPDATE.
2. Load `abox:asserted` + `normalization` into an in-memory `Model`.
3. Apply `GenericRuleReasoner` with **forward rules only** (`setMode(GenericRuleReasoner.FORWARD_RETE)`).
4. Extract all inferred triples: `infModel.listStatements()` minus the base model statements.
5. INSERT all inferred triples into `urn:{datasetId}:abox:inferred` via SPARQL UPDATE.
6. Log a materialization event to `urn:{datasetId}:system:health`.

`abox:inferred` is the only graph that can be freely wiped and regenerated. No other graph is touched.

---

### 4C: Admin Web Page

**`services/web/src/pages/admin/index.astro`** *(new)*

Dashboard with:
- Triple counts per named graph per dataset (from `GET /health/metrics`)
- Reload ontology button per dataset (`POST /admin/reload?dataset={id}`)
- Refresh InfModel button per dataset (`POST /admin/refresh-model?dataset={id}`)
- Trigger materialization button per dataset (`POST /admin/materialize?dataset={id}`)
- Last materialization timestamp and triple count

---

### Phase 4 Integration Checkpoint

```
1. GET /health/metrics                  → shows triple count per named graph per dataset
2. GET /actuator/prometheus             → shows kg_triple_count gauges
3. POST /admin/materialize?dataset=economic-census
                                        → logs materialized triple count
4. SELECT * FROM <urn:economic-census:abox:inferred> WHERE { ?s ?p ?o } LIMIT 10
                                        → returns forward-chained inferences
5. Admin page at /admin                 → all buttons functional, counts visible
```

---

## Critical Implementation Risks

### 1. Prisma + pgvector vector insertion (Phase 1 blocker)

Plain Prisma interpolation casts the vector as `text`. Use `Prisma.raw()` to inline the `::vector` cast. Without this fix, the indexing worker fails at step 1 of every document.

### 2. Jena RDF-star in SPARQL JSON serialization (Phase 1)

`ResultSetFormatter` in Jena 5.x serializes triple terms as nested objects in JSON. The web UI must handle the nested structure when parsing `<< ?s ?p ?o >>` bindings in provenance queries. Test against Fuseki directly before wiring the backend endpoint.

### 3. GenericRuleReasoner HYBRID mode is memory-bound (Phase 2)

At millions of triples the ABox snapshot must fit in JVM heap. Size the container heap (`-Xmx`) to at least 2x the expected ABox size. The singleton InfModel cache strategy avoids per-request reload cost; the trade-off is stale data between assertion and refresh.

### 4. RDFDataMgr + conn.load() vs. Fuseki LOAD command (Phase 1)

`LOAD <file:///...>` requires Fuseki to see the same filesystem path as the backend — breaks when they are separate containers. Always use `RDFDataMgr.loadModel(path)` in the backend JVM followed by `conn.load(graphUri, model)` (HTTP PUT to Fuseki graph store). This works regardless of deployment topology.

### 5. manifest.yaml bindingsPath rename (Phase 3)

SnakeYAML and `yaml.parse()` both return `null` silently for unrecognized fields — there is no parse error on rename. The Java POJO, TypeScript type, and YAML file must all be updated in the same commit or `OntologyLoaderService` will skip bindings loading without error.
