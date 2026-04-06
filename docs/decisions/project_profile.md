1. java backend as entry point for the whole rdf store; providing interface to and from rdf store to the rest of the system. expose SQARQL endpoint and performing backward chainin inference rules.
2. apache jena fuseki (multiple datasets for different domains)
3. ontology and inference rules in a folder, version control, import to the rdf store, as Tbox information
4. unstructured data extraction: temporal server + worker for indexing data (in typescript) + use LLM/AI for data extraction. the unstructured document is stored in postgres with chunk and vector for vector query look up. the reference of postgres for look up of document in postgres from rdf store. Use prisma as ORM.
5. this rdf store is serving human via a wikipedia like web server and serving AI via MCP or CLI.
6. for structured data, this will be in google big query, it will not be ingested to our rdf store, but we will have semantic binding layer that connects unstructured data to the relational database. this is to avoid expensive full copy from SQL database to rdf store. the semantic binding layer will tell the AI how to query the big query. The rdf lift strategy is query time translation by providing to the LLM/AI the table and query example to let LLM query the data. 
7. the ontology, inference rules, and data themselves are served via a web server for human navigation, understanding and manipulation. the web server is build using react, astro, and the SPARQL endpoint from java backend.
8. the entities are versioned bi-temporally allowing for time travel queries if needed.
9. all of the assertion triplet have provenance i.e. ability to trace back to the source document and version. should this be in a separate named graph? the provenance allows for retraction of triplets when the source document or the assertion is retracted. this can be done via rdf star.
10. entity normalization is done through owl same as, using the power of inference rules, and allows us to provide links from many same entities to the canonical entity and vice versa. the normalization strategy follows multi-tier strategy: rule-based NLP when confidence score is high, and uses LLM as a judge when confidence score is lower to save on cost. and we don't do destructive hard merging; we use same_as link and inference rules to help us. 
11. this graph database is metadata driven development where the metadata is the ontology and inference rules. they are version controlled and can evolve over time as new understanding of ontology becomes available.
12. the inference rules are hybrid, basic ontology rules that are unlikely to change will be done via materialization (forward chaining), the custom or domain specific rules are done on the fly via backward chaining.
13. avoid exploding of triplets. the ontology inference rules or provenance should not cause the number of triplets to exponentially increase.
14. the graph life cycle is continuous, meaning the entity is stable over time and we don't nuke and rebuild. we prefer to merging and deduplication and perform data cleaning over time.
15. the number of triplet count is expected to be around millions 
16. the query use cases will be mix of look up, analytical traversal, and full text search. therefore we require text index capability
17. the model is open world schema documentation.
18.  expose health endpoints to allow us to know cpu usage, memory usage, number of triplet in each named graph, etc. or health of the database.

---

updated 
in terms of bi temporal modeling: use rdf start for provenance tell me more about the backward chaining (on the fly reasoning). what do we need to do? I thought apache jena library in java support backward chaining. should I use things like datalog? does it work with apache jena? 

in terms of owl:sameAs being explosion risk. this is acceptable because entity normalization is essential for our rdf store. so we should be willing to accept the storage cost there. 

in terms of SQL big query validation. we will handle this in the next phase. schema evolution will be done via ontology evolution and update. the update could be done via rule materialization. it will probably be done not often but periodically. 

no SHACL validation in the first phase. 

LLM extraction quality is guided by the ontology. that means the ontology is queried from the graph and stored in the indexing pipeline. the ontology is appended to the llm prompt. the LLM extraction uses structured output with pydantic model.

all ontology and rules even though we uses ttl files as entrypoint, they are all inputed into 

---


# Knowledge Graph System — Design Document

> **Status**: Living document — evolves with ontology and system understanding  
> **Stack**: Apache Jena Fuseki · Java Backend · typescript Indexing Pipeline · React/Astro Frontend · MCP/CLI

---

## 1. Vision & Purpose

This knowledge graph is a **semantic integration layer** — not a data warehouse. Its purpose is to own the *meaning layer* across heterogeneous data sources: unstructured documents and structured relational data (Google BigQuery). It does not copy all data into the graph; it asserts semantic facts, entity identity, and provenance, and provides a unified query surface for both human navigation and AI reasoning.

The system is **metadata-driven**: the ontology and inference rules are the authoritative schema. Everything — data, rules, ontology, provenance, system state — lives inside the graph and is queryable via SPARQL. Nothing is hardcoded outside the graph except the minimal Java bootstrapping code that knows which named graph URIs to query at startup.

---

## 2. System Profile & Characteristics

| Dimension | Profile |
|---|---|
| **Triplestore** | Apache Jena Fuseki with TDB2 persistent storage |
| **Scale** | Mid-scale: millions of triples |
| **OWL Profile** | OWL-RL / OWL-DL subset — reasoning must remain decidable |
| **World Assumption** | Open World — schema is documentation, not enforcement |
| **Reasoning Mode** | Hybrid: forward chaining (materialized) + backward chaining (query-time) |
| **Temporality** | Bi-temporal: valid time + transaction time via RDF-star |
| **Provenance** | Triple-level via RDF-star; graph-level via named graph segmentation |
| **Entity Identity** | Non-destructive normalization via `owl:sameAs` + inference rules |
| **Ontology Lifecycle** | Additive-first, version-controlled, `owl:imports`-composed |
| **Query Profile** | Mixed: SPARQL lookup, graph traversal, full-text search, backward chaining |
| **Consumers** | Human (React/Astro UI) · AI (MCP/CLI) · Java backend (SPARQL gateway) |
| **Graph Lifecycle** | Continuous — merge, deduplicate, retract. Never nuke and rebuild |
| **Validation** | Phase 1: none (open world). Phase 2: SHACL gates at ingestion |
| **Text Search** | Jena-text (Apache Lucene) integration over selected literal predicates |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      Consumers                          │
│  React/Astro UI       MCP / CLI Tools       REST APIs   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   Java Backend                          │
│  · SPARQL endpoint gateway                              │
│  · Reasoner router (InfModel vs raw TDB2)               │
│  · Rule loader (queries rules from named graph)         │
│  · Health & metrics endpoints                           │
│  · owl:sameAs canonical resolution                      │
└────────┬───────────────────────────┬────────────────────┘
         │                           │
┌────────▼────────┐       ┌──────────▼──────────┐
│  Jena InfModel  │       │    Raw TDB2 Dataset  │
│  (with rules)   │       │  (Fuseki, TDB2)      │
│  forward+back   │       │  provenance, health  │
│  chaining       │       │  tbox, text index    │
└─────────────────┘       └─────────────────────┘
         │
┌────────▼──────────────────────────────────────────────┐
│              Named Graph Store (TDB2)                  │
│  urn:tbox:ontology        urn:abox:asserted            │
│  urn:tbox:rules:forward   urn:abox:inferred            │
│  urn:tbox:rules:backward  urn:normalization            │
│  urn:provenance           urn:system:health            │
└───────────────────────────────────────────────────────┘
         ▲                        ▲
┌────────┴────────┐    ┌──────────┴──────────┐
│ typescript Indexing │    │   Google BigQuery    │
│ Pipeline        │    │   (semantic binding  │
│ (Temporal srv + │    │    layer — virtual,  │
│  LLM extraction)│    │    query-time lift)  │
└─────────────────┘    └─────────────────────┘
```

---

## 4. Named Graph Convention

Every piece of information in the system has a designated named graph. No triple exists outside a named graph. This enables precise provenance, segmented reasoning, and independent lifecycle management per graph.

### 4.1 TBox Graphs (Schema Layer)

| Named Graph | Contents |
|---|---|
| `urn:tbox:ontology` | OWL/RDFS classes, properties, axioms, `owl:imports` declarations |
| `urn:tbox:rules:forward` | Forward chaining rules stored as RDF literals |
| `urn:tbox:rules:backward` | Backward chaining rules stored as RDF literals |

TBox graphs are the **metadata** of the system. They evolve via version-controlled updates and are loaded into the Java backend at startup and on-demand reload. The ontology is also queried by the typescript extraction pipeline to guide LLM-based entity extraction.

### 4.2 ABox Graphs (Data Layer)

| Named Graph | Contents |
|---|---|
| `urn:abox:asserted` | All asserted triples from extraction and ingestion pipelines |
| `urn:abox:inferred` | Materialized output of forward chaining — safe to wipe and rebuild |

`urn:abox:inferred` is the only graph that can be freely regenerated. It is downstream of all other graphs and has no independent provenance value.

### 4.3 Semantic Infrastructure Graphs

| Named Graph | Contents |
|---|---|
| `urn:normalization` | `owl:sameAs` links, canonical entity declarations, normalization metadata |
| `urn:provenance` | RDF-star triple-level provenance: source doc, confidence, timestamp, version |
| `urn:system:health` | Durable operational facts: rule reload events, ontology version lineage |

### 4.4 Why `urn:normalization` is Separate from `urn:abox:inferred`

This is a critical distinction:

- `urn:abox:inferred` is **automatically derived** by the reasoner. It is ephemeral: wipe and regenerate at any time.
- `urn:normalization` contains **intentional decisions** made by the normalization pipeline or a human. These are curated judgments with provenance (confidence score, method used, evidence). They are not regenerated — they are managed.

Furthermore, `urn:normalization` is an **input** to the reasoner. The `owl:sameAs` triples it contains feed into the InfModel which then populates `urn:abox:inferred`. They sit on opposite sides of the reasoning boundary:

```
urn:normalization  →  (input)  →  Jena InfModel  →  (output)  →  urn:abox:inferred
```

Conflating them would make it impossible to distinguish what the system *decided* from what the engine *derived*.

---

## 5. Reasoning Architecture

### 5.1 Hybrid Reasoning Strategy

The system uses **Jena Rule Language** for all inference. Rules are divided into two classes with different execution strategies:

| Rule Class | Execution | Stored In | When Applied |
|---|---|---|---|
| **Forward rules** | RETE forward chaining — materialized | `urn:tbox:rules:forward` | At load time and on ontology update |
| **Backward rules** | Tabled LP backward chaining — on-demand | `urn:tbox:rules:backward` | At query time via InfModel |

**Forward chaining** is used for stable, high-confidence rules that are unlikely to change: subclass transitivity, property domain/range inference, `owl:sameAs` symmetry and transitivity closure, and other OWL-RL axioms.

**Backward chaining** is used for domain-specific, dynamic rules that are evaluated only when queried: entity classification, canonical form resolution, relationship derivation based on complex patterns.

### 5.2 Rules as Graph Citizens

Rules are stored as RDF literals inside the graph — not as external YAML or text files. This makes them fully queryable, versionable, and manageable alongside all other graph data.

**Rule vocabulary** (defined in `urn:tbox:ontology`):

```turtle
ex:Rule           a owl:Class .
ex:ForwardRule    a owl:Class ; rdfs:subClassOf ex:Rule .
ex:BackwardRule   a owl:Class ; rdfs:subClassOf ex:Rule .

ex:ruleBody       a owl:DatatypeProperty ; rdfs:range xsd:string .
ex:ruleName       a owl:DatatypeProperty .
ex:ruleVersion    a owl:DatatypeProperty .
ex:ruleStatus     a owl:DatatypeProperty . # active | deprecated
ex:ruleOrder      a owl:DatatypeProperty ; rdfs:range xsd:integer .
ex:replacedBy     a owl:ObjectProperty   ; rdfs:domain ex:Rule .
```

**Example rule instance** (in `urn:tbox:rules:forward`):

```turtle
ex:rule_sameAs_symmetry
    a ex:ForwardRule ;
    ex:ruleName    "sameAs Symmetry" ;
    ex:ruleVersion "1.0.0" ;
    ex:ruleStatus  "active" ;
    ex:ruleOrder   10 ;
    ex:ruleBody    """[sameAsSymm: (?a owl:sameAs ?b) -> (?b owl:sameAs ?a)]""" .
```

Rule deprecation is non-destructive — status is updated, not deleted:

```turtle
ex:rule_old_classification
    ex:ruleStatus "deprecated" ;
    ex:replacedBy ex:rule_new_classification .
```

### 5.3 Java Backend as Reasoner Router

The Java backend is the **sole gateway** through which all consumers query the graph. It routes queries to either the InfModel or raw TDB2 based on what the query needs:

```
POST /query/reasoned   → InfModel (backward chaining + sameAs closure)
POST /query/raw        → TDB2 directly (provenance, health, tbox browsing)
POST /query/text       → Jena-text index → then canonical resolution via InfModel
POST /query/tbox       → TBox named graphs only (ontology + rules introspection)
```

At startup, the Java backend queries `urn:tbox:rules:forward` and `urn:tbox:rules:backward`, parses rule literals in `ex:ruleOrder` sequence, and builds a `GenericRuleReasoner` in `HYBRID` mode. On ontology or rule update, the reasoner is rebuilt by re-querying the graph — no restart required.

**The InfModel is not always on.** It is a lens applied selectively. Provenance and health queries bypass the reasoner entirely for performance.

---

## 6. Entity Identity & Normalization

### 6.1 Non-Destructive Normalization

The system never hard-merges entities. Entity identity is managed via `owl:sameAs` links to a canonical entity, stored in `urn:normalization`. The reasoner applies symmetry and transitivity to make co-referent entities transparent at query time.

```
<urn:entity:apple_inc_1>        owl:sameAs  <urn:entity:apple_canonical>
<urn:entity:apple_incorporated>  owl:sameAs  <urn:entity:apple_canonical>
```

A query against `<urn:entity:apple_canonical>` via the InfModel automatically includes triples asserted against all co-referent entities.

### 6.2 Multi-Tier Normalization Strategy

| Tier | Method | Condition | Output |
|---|---|---|---|
| **Tier 1** | Rule-based NLP | Confidence score above threshold | Directly asserts `owl:sameAs` |
| **Tier 2** | LLM-as-judge | Confidence score below threshold | LLM evaluates, then asserts `owl:sameAs` |

This strategy minimizes LLM cost by only invoking the judge for ambiguous cases. Both tiers record their method and confidence score as RDF-star metadata on the `owl:sameAs` triple in `urn:normalization`.

### 6.3 Storage Cost Acceptance

The `owl:sameAs` symmetry and transitivity closure will materialize additional triples in `urn:abox:inferred`. This storage cost is explicitly accepted as a deliberate trade-off. Entity normalization is essential to the system's semantic correctness and the ability to traverse complex entity graphs transparently. The expected triple count at millions of entities remains well within TDB2's operational range.

---

## 7. Provenance & Bi-Temporal Modeling

### 7.1 RDF-star for Triple-Level Provenance

Every asserted triple in `urn:abox:asserted` carries provenance via RDF-star annotation. This enables retraction, time travel, and full audit trails without a separate provenance store.

```turtle
<<<urn:entity:apple_canonical> ex:revenue "383B"^^xsd:string>>
    ex:sourceDocument  <urn:doc:earnings_report_2024> ;
    ex:extractedAt     "2024-01-15T10:00:00Z"^^xsd:dateTime ;
    ex:confidence      0.94 ;
    ex:extractionMethod "llm:gpt-4o" ;
    ex:validFrom       "2024-01-01T00:00:00Z"^^xsd:dateTime ;
    ex:validTo         "2024-12-31T23:59:59Z"^^xsd:dateTime ;
    ex:transactionTime "2024-01-15T10:00:00Z"^^xsd:dateTime .
```

### 7.2 Bi-Temporal Dimensions

| Dimension | Meaning | Predicate |
|---|---|---|
| **Valid time** | When the fact was true in the real world | `ex:validFrom` / `ex:validTo` |
| **Transaction time** | When the triple was recorded in the graph | `ex:transactionTime` |

This enables time travel queries: "what did we know about entity X as of date D, reflecting facts valid at time T?"

### 7.3 Retraction via Provenance

When a source document is retracted or an assertion is found to be incorrect, the retraction is performed by:
1. Setting `ex:validTo` on the affected RDF-star annotation
2. Asserting a retraction event in `urn:provenance`
3. Triggering re-evaluation of forward-chained triples that depended on the retracted assertion

No triple is physically deleted. Retraction is a temporal close-off, preserving the full audit history.

---

## 8. Data Sources & Ingestion

### 8.1 Unstructured Data Pipeline

```
Source Documents
      ↓
Temporal Server + TypeScript Worker (indexing pipeline)
      ↓
Chunking + vector embeddings → stored in postgres along with the raw document itself
      ↓
LLM extraction (ontology-guided, structured output via Zod schema)
      ↓
RDF triples with RDF-star provenance → asserted into urn:abox:asserted
```

**Ontology-guided extraction**: the TypeScript pipeline queries `urn:tbox:ontology` from the graph at indexing time and appends the ontology to the LLM extraction prompt. LLM output is constrained by Zod schemas derived from the ontology structure. This couples extraction quality directly to ontology maturity.

**Postgres role**: stores chunks and vectors for vector similarity lookup. The Postgres row ID is referenced in the RDF provenance graph as the source document pointer, enabling the Java backend to retrieve source text from PostgreSQL. Use prisma in typescript as ORM. 

**Language strategy**: the indexing pipeline and the React/Astro web server are both written in TypeScript. This means the system is maintained in exactly two languages — **Java** (backend gateway, reasoning, Fuseki management) and **TypeScript** (indexing pipeline, web server, MCP/CLI tools). This minimizes operational complexity, shared tooling, and the cognitive overhead of context-switching across runtimes.

### 8.2 Structured Data — Semantic Binding Layer (BigQuery)

Structured relational data in Google BigQuery is **not ingested into the graph**. A semantic binding layer connects the two systems at query time:

- RDF entities carry references to BigQuery table identifiers as properties
- The binding layer provides the LLM/AI with table schemas, column semantics, and query examples
- The AI generates BigQuery SQL at query time — a **virtual, query-time RDF lift**
- No full copy of relational data enters the triplestore

This avoids expensive replication while preserving the ability for AI consumers to reason across both semantic and relational data. BigQuery query validation and cost guardrails are deferred to Phase 2.

### 8.2 Structured Data — Semantic Binding Layer (BigQuery)

Structured relational data in Google BigQuery is **not ingested into the graph**. A semantic binding layer connects the two systems at query time:

- RDF entities carry references to BigQuery table identifiers as properties
- The binding layer provides the LLM/AI with table schemas, column semantics, and query examples
- The AI generates BigQuery SQL at query time — a **virtual, query-time RDF lift**
- No full copy of relational data enters the triplestore

This avoids expensive replication while preserving the ability for AI consumers to reason across both semantic and relational data. BigQuery query validation and cost guardrails are deferred to Phase 2.

---

## 9. IRI Minting Strategy

### 9.1 Design Choice: Slash IRIs with UUID Slugs

The system uses **Option 1: Slash IRIs with content negotiation**, with **UUID-based slugs**. The IRI is identical to the web URL of the React/Astro entity page. The same URL serves both humans and machines via the `Accept` header:

```
Accept: text/html             → React/Astro entity page
Accept: application/ld+json   → JSON-LD RDF description
Accept: text/turtle           → Turtle RDF description
```

This satisfies three requirements simultaneously:
- **Stable**: UUID slugs never change regardless of label evolution
- **Citable**: the IRI is dereferenceable — clicking it returns a meaningful page
- **Co-located**: the IRI is identical to the React/Astro web URL — no mapping layer needed

### 9.2 IRI Structure

```
https://{base_url}/{type}/{uuid}

Examples:
https://kg.yourdomain.com/entity/a7f3c291-4b2e-4d1a-9f8e-123456789abc
https://kg.yourdomain.com/concept/b3e1d842-9c3f-4a2b-8d7e-234567890bcd
https://kg.yourdomain.com/event/c4f2e953-0d4g-5b3c-9e8f-345678901cde
https://kg.yourdomain.com/document/d5a3f064-1e5h-6c4d-0f9g-456789012def
https://kg.yourdomain.com/class/e6b4a175-2f6i-7d5e-1g0h-567890123efg
https://kg.yourdomain.com/property/f7c5b286-3g7j-8e6f-2h1i-678901234fgh
https://kg.yourdomain.com/rule/g8d6c397-4h8k-9f7g-3i2j-789012345ghi
```

### 9.3 Type Segments



### 9.4 Human-Readable Slug Redirect

Because UUIDs are not human-memorable, a **slug redirect** is provided alongside the canonical IRI. The slug is derived from the canonical label at mint time and stored as a graph property:

```turtle
<https://kg.yourdomain.com/entity/a7f3c291-4b2e-4d1a-9f8e-123456789abc>
    a ex:Entity ;
    rdfs:label    "Apple Inc." ;
    ex:slug       "apple-inc" ;
    ex:mintedAt   "2026-04-05T10:00:00Z"^^xsd:dateTime ;
    ex:mintedFrom <https://kg.yourdomain.com/document/d5a3f064-...> .
```

The Astro server resolves the slug to the canonical UUID IRI and issues a permanent redirect:

```
GET /entity/apple-inc
  → 301 Permanent Redirect
  → /entity/a7f3c291-4b2e-4d1a-9f8e-123456789abc
```

The **canonical IRI is always the UUID form**. The slug is a convenience alias only. External documents should cite the UUID IRI for long-term stability. The slug can be updated (e.g., if a label changes significantly) without breaking the canonical IRI.

### 9.5 Slug Collision Handling

When two entities produce the same slug, a disambiguation qualifier is appended:

```
# Two entities with label "John Smith"
john-smith           → first minted, takes the unqualified slug
john-smith--2        → collision resolved by sequence suffix

# Or domain-qualified for clarity
john-smith--person
john-smith--organization
```

Collision resolution is handled by the minting pipeline via SPARQL lookup before slug assignment.

### 9.6 IRI Minting Pipeline

```
New entity arrives from TypeScript extraction pipeline
        ↓
1. Query urn:normalization for existing owl:sameAs match
   → if match found: return canonical IRI, skip minting
        ↓
2. Determine type segment (entity / concept / event / document / ...)
        ↓
3. Generate UUID (v4) — this becomes the permanent slug
        ↓
4. Derive human-readable slug from canonical label
   → normalize unicode, lowercase, hyphenate
   → SPARQL collision check against ex:slug in urn:abox:asserted
   → apply disambiguation suffix if collision found
        ↓
5. Assert IRI with minting metadata in urn:abox:asserted:
   rdfs:label    "Apple Inc."
   ex:slug       "apple-inc"
   ex:mintedAt   "2026-04-05T..."^^xsd:dateTime
   ex:mintedFrom <source document IRI>
        ↓
6. IRI and UUID slug are now permanent and immutable
   Human-readable slug is stable but may be updated if needed
```

---

## 10. MCP Tool Design

MCP tools are the primary AI interface to the knowledge graph. All MCP tools route through the Java backend — never directly to Fuseki. This ensures backward chaining and `owl:sameAs` normalization apply consistently.

| Tool | Route | Reasoning Applied |
|---|---|---|
| **Entity Lookup** | `/query/reasoned` | Backward chaining + sameAs closure |
| **Full Text Search** | `/query/text` → `/query/reasoned` | Text index → then canonical resolution |
| **Ontology Query** | `/query/tbox` | None — raw TBox graphs |
| **Time Travel Query** | `/query/reasoned` | Backward chaining on historical state |
| **Graph Traversal** | `/query/reasoned` | Backward chaining enriches traversal nodes |
| **Provenance Lookup** | `/query/raw` | None — raw provenance graph |

### Full Text Search — Two-Hop Pattern

Full text search follows a two-hop pattern because the Jena-text index operates on raw TDB2 and does not participate in inference:

```
1. Text query → jena-text index → candidate entity IRIs
2. Candidate IRIs → InfModel → canonical entity resolution via sameAs
```

This ensures that even if a text match lands on a non-canonical alias entity, the result is resolved to the canonical form before being returned to the MCP tool.

### owl:sameAs Transparency

Because the InfModel applies `owl:sameAs` closure, MCP tools work exclusively with canonical entity IRIs. The tool does not need to know about aliases or co-referent variants. The reasoner collapses them transparently:

```sparql
# Tool queries canonical entity
# Reasoner automatically includes triples from all aliases
SELECT ?p ?o WHERE {
    <urn:entity:apple_canonical> ?p ?o .
}
```

---

## 11. Ontology & Schema Evolution

### 10.1 Principles

- **Additive-first**: new classes and properties are added; existing ones are not renamed or deleted in place
- **Deprecation over deletion**: deprecated classes/properties are marked with `owl:deprecated true` and a `rdfs:comment` migration note
- **Version-controlled**: ontology files live in version control (Git) and are imported into `urn:tbox:ontology` via `owl:imports`
- **Non-breaking by default**: breaking changes require explicit migration scripts (SPARQL UPDATE) and a version bump

### 10.2 Evolution Lifecycle

```
1. Author ontology change in version control
2. Review impact on existing rules and asserted triples
3. Write SPARQL UPDATE migration if structural change required
4. Import updated ontology into urn:tbox:ontology
5. Reload rules from urn:tbox:rules:forward + urn:tbox:rules:backward
6. Re-run forward chaining materialization into urn:abox:inferred
7. Record version event in urn:system:health
```

Step 6 (re-materialization) is a periodic batch operation — not continuous. The forward chaining graph (`urn:abox:inferred`) is wiped and rebuilt. All other graphs are unaffected.

---

## 12. System Health & Observability

### 11.1 What Lives in the Graph (`urn:system:health`)

Durable operational facts that have long-term query value:

- **Rule reload events**: how many rules loaded, which ontology version triggered the reload
- **Ontology version lineage**: version chain with load timestamps

These are queryable via SPARQL and form part of the graph's audit history.

### 11.2 What Lives Outside the Graph (HTTP Endpoints)

Live infrastructure signals exposed by the Java backend:

```
GET /health/live      → JVM heap, CPU usage, TDB2 lock status
GET /health/ready     → Fuseki reachability, InfModel loaded, rules count
GET /health/metrics   → Prometheus-compatible metrics for dashboarding
```

**Guiding principle**: if a future SPARQL query would benefit from knowing it, store it in the graph. If it only matters right now to an ops dashboard, expose it via HTTP.

---

## 13. Graph Lifecycle Principles

1. **Continuous, never rebuilt**: entities are stable over time. The graph is cleaned, merged, and deduplicated incrementally.
2. **Retraction over deletion**: facts are closed off temporally, not physically removed.
3. **Additive ontology evolution**: schema changes extend the model; they do not break existing triples.
4. **Inferred graph is ephemeral**: `urn:abox:inferred` is the only graph that can be freely wiped and regenerated.
5. **Triple explosion is actively managed**: `owl:sameAs` cost is accepted; all other proliferation (provenance, rules, bi-temporality) is controlled by using RDF-star annotation and named graph segmentation rather than materializing additional triples.
6. **Everything queryable**: no configuration, rules, or system state lives outside the graph. The graph is self-describing.

---

## 14. Phase Roadmap

| Phase | Scope |
|---|---|
| **Phase 1** | Core triplestore, ontology, forward + backward chaining, entity normalization, RDF-star provenance, bi-temporal modeling, MCP tools, React/Astro UI, Java backend gateway, typescript extraction pipeline |
| **Phase 2** | SHACL validation gates at ingestion, BigQuery query validation + cost guardrails, full observability stack (Prometheus + Grafana) |
| **Phase 3** | Federated SPARQL (`SERVICE`), cross-domain reasoning, ontology alignment with external vocabularies |