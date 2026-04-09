# SPARQL-to-SQL Query Rewriting — Design & Discovery

> **Status**: Design doc (Phase 3 — not yet implemented)
> **Related**: `docs/decisions/semantic-binding.md`, `ontology/insurance/bindings.ttl`

---

## 1. Problem Statement

The ACME Insurance benchmark defines 44 natural language questions, each accompanied by two ground-truth answers:

1. A **SPARQL** query against the OWL knowledge graph (`in:` namespace)
2. A **SQL** query against the relational database

In the current architecture:
- The **RDF store** (Apache Jena Fuseki) answers SPARQL queries against the `urn:insurance:tbox:ontology` and `urn:insurance:abox:*` named graphs.
- The **PostgreSQL store** (`postgres-kg`, schema `acme_insurance`) answers SQL queries directly.

These two stores require two separate query paths. A SPARQL-to-SQL rewriter would allow a single semantic SPARQL query — expressed in the `in:` vocabulary — to be automatically translated into an equivalent SQL query against PostgreSQL, without loading all RDF triples into memory first.

This is a **Virtual Knowledge Graph (VKG)** approach: the ontology is the query interface; the relational database is the storage.

---

## 2. Current Architecture

```
User / LLM
  │
  ├──  SPARQL  ──▶  Fuseki (urn:insurance:abox:asserted)
  │                  (requires RDF lift from Postgres first)
  │
  └──  SQL     ──▶  postgres-kg / acme_insurance
                     (direct; ground truth for benchmark)
```

The **R2RML binding layer** (`ontology/insurance/bindings.ttl`, loaded into `urn:insurance:bindings`) already contains the mapping between the two worlds:

| R2RML concept | Insurance example |
|---|---|
| `rr:TriplesMap` | `<#Policy>` |
| `rr:logicalTable / rr:sqlQuery` | `SELECT ... FROM {schema}.policy` |
| `rr:subjectMap / rr:class` | `in:Policy` |
| `rr:predicateObjectMap` | `in:policyNumber` ↔ column `policy_number` |

The binding layer gives us exactly the information needed to translate SPARQL triple patterns to SQL table scans and joins.

---

## 3. Translation Strategy

### 3.1 Core Idea

A SPARQL triple pattern `?x a in:Policy` resolves to a SQL table scan via the R2RML subject map:
- Look up which TriplesMap declares `rr:class in:Policy`
- Its `rr:logicalTable` gives the SQL source: `SELECT ... FROM {schema}.policy`
- The subject IRI template `{schema}/Policy-{policy_identifier}` identifies the join key: `policy_identifier`

More complex patterns follow the same logic through `rr:predicateObjectMap`:

| SPARQL pattern | R2RML lookup | SQL translation |
|---|---|---|
| `?x a in:Policy` | `<#Policy> rr:class in:Policy` | `FROM {schema}.policy` |
| `?x in:policyNumber ?n` | `<#Policy> in:policyNumber ↔ column "policy_number"` | `policy.policy_number AS n` |
| `?x in:hasCatastrophe ?c` | `<#Claim> in:hasCatastrophe` → join FK `catastrophe_identifier` | `JOIN {schema}.catastrophe c ON claim.catastrophe_identifier = c.catastrophe_identifier` |

### 3.2 Translation Pipeline

```
SPARQL SELECT query
        │
        ▼ (1) Parse with SPARQL algebra
SPARQL Algebra tree (BGP, JOIN, FILTER, PROJECT, etc.)
        │
        ▼ (2) Pattern matching against R2RML bindings
         For each triple pattern (s, p, o):
           - Identify TriplesMap by class (rr:class) or predicate (rr:predicateObjectMap)
           - Extract SQL source (rr:sqlQuery) and column mapping
        │
        ▼ (3) SQL plan construction
         - FROM clause: logical tables from matched TriplesMaps
         - JOIN conditions: derived from R2RML join conditions or FK graph
         - SELECT list: projected variables → columns
         - WHERE clause: SPARQL FILTER → SQL WHERE
        │
        ▼ (4) Template variable resolution
         - Replace {schema} with manifest.postgres.schema
        │
        ▼ (5) SQL string output
PostgreSQL-compatible SELECT query
```

### 3.3 SPARQL Algebra Fragments to Support

| SPARQL construct | SQL equivalent | Complexity |
|---|---|---|
| Basic Graph Pattern (single triple) | Table scan | Low |
| BGP join (multiple triples, same subject) | SELECT with multiple columns | Low |
| BGP join (different subjects, object property) | SQL JOIN | Medium |
| FILTER | WHERE clause | Medium |
| OPTIONAL | LEFT JOIN | Medium |
| SELECT (projection) | SELECT column list | Low |
| SELECT DISTINCT | SELECT DISTINCT | Low |
| ORDER BY | ORDER BY | Low |
| LIMIT / OFFSET | LIMIT / OFFSET | Low |
| Aggregate (COUNT, SUM, AVG, MIN, MAX) | GROUP BY + aggregate | Medium |
| UNION | UNION ALL | Medium |
| GRAPH <named-graph> | Ignore (use schema routing instead) | N/A |

### 3.4 Join Derivation from R2RML

Object property joins (e.g. `?claim in:hasCatastrophe ?cat`) require deriving the SQL JOIN condition. Two R2RML mechanisms provide this:

**Option A — `rr:joinCondition`**: R2RML allows explicit join conditions between TriplesMaps:
```turtle
rr:predicateObjectMap [
  rr:predicate in:hasCatastrophe ;
  rr:objectMap [
    rr:parentTriplesMap <#Catastrophe> ;
    rr:joinCondition [ rr:child "catastrophe_identifier" ; rr:parent "catastrophe_identifier" ]
  ]
] .
```

**Option B — FK graph inference**: If the bindings file doesn't include explicit `rr:joinCondition` entries, join conditions can be inferred from the `ex:joinKey` annotation and the PostgreSQL FK constraint graph (queryable via `information_schema.referential_constraints`).

For the insurance domain, the FK graph in `infra/postgres/init-insurance.sql` is the ground truth.

---

## 4. Reference Implementations

| System | Approach | Notes |
|---|---|---|
| **ontop** | Full VKG engine (R2RML + SPARQL rewriting) | Production-grade; Java; complex dependency |
| **Morph-KGC** | RML-based materialisation; no query rewriting | Materialises RDF rather than rewriting queries |
| **D2RQ** | Proprietary mapping language; query rewriting | Deprecated; predecessor to R2RML |
| **SPARQL-to-SQL (W3C note)** | Reference translation rules in the R2RML spec (Appendix) | Formal definition; basis for implementation |
| **Jena ARQ** | SPARQL algebra API (no built-in rewriting) | Can be used to parse SPARQL to algebra tree |

Relevant specifications:
- W3C R2RML Recommendation: `https://www.w3.org/TR/r2rml/` (Section 11: Querying)
- SPARQL 1.1 Algebra: `https://www.w3.org/TR/sparql11-query/#sparqlAlgebra`
- Direct Mapping: `https://www.w3.org/TR/rdb-direct-mapping/`

Key paper: *"Efficient SPARQL-to-SQL with R2RML Mappings"* (Calvanese et al., 2017) — describes the Ontop approach and formal correctness conditions.

---

## 5. Insurance Domain Specifics

The ACME benchmark has characteristics that affect the rewriter:

### Subtype pattern (single-table inheritance via FK)
`loss_payment`, `loss_reserve`, `expense_payment`, `expense_reserve` are modelled as FK-only tables pointing to `claim_amount`. A SPARQL query for `?x a in:LossPayment` must JOIN the two tables:
```sql
SELECT ca.*, lp.*
FROM acme_insurance.loss_payment lp
JOIN acme_insurance.claim_amount ca ON ca.claim_amount_identifier = lp.claim_amount_identifier
```

### Role-based filtering (agreement_party_role)
`in:Agent` and `in:PolicyHolder` both map to `agreement_party_role` with different `party_role_code` values. The TriplesMap SQL already includes the WHERE clause:
```sql
SELECT * FROM acme_insurance.agreement_party_role WHERE party_role_code = 'AG'
```
The rewriter must include this predicate filter when generating the FROM clause for `in:Agent`.

### No ABox in Fuseki (pre-lift)
At present, no RDF lift from Postgres to Fuseki has been performed for the insurance dataset. SPARQL queries against `urn:insurance:abox:asserted` return no results. The SPARQL-to-SQL rewriter is the primary query path for this domain until an ETL lift is implemented.

---

## 6. Implementation Roadmap

### Phase 1 — Single-table patterns (lowest effort)
Target: translate SPARQL queries with a single rdf:type constraint and data property projections.

Example input:
```sparql
PREFIX in: <http://data.world/schema/insurance/>
SELECT ?num ?eff ?exp
WHERE { ?p a in:Policy ; in:policyNumber ?num ; in:policyEffectiveDate ?eff ; in:policyExpirationDate ?exp }
```
Expected output:
```sql
SELECT policy_number, effective_date, expiration_date
FROM acme_insurance.policy
```

Implementation: parse SPARQL, identify rdf:type triple → look up TriplesMap by class → project columns from predicateObjectMaps.

### Phase 2 — Two-table joins (object properties)
Add support for one level of object property join (e.g. claim → catastrophe, policy → agent).

### Phase 3 — Aggregates
`COUNT`, `SUM`, `AVG` — needed for ~30 of the 44 benchmark questions.

### Phase 4 — FILTER and OPTIONAL
Covers date range filters, NULL checks, and optional outer joins.

---

## 7. Open Questions

1. **Blank node subjects**: R2RML `rr:template` patterns generate IRI subjects. Blank nodes in SPARQL `?x a in:Policy` can match any node. Does the rewriter need to handle blank-node-only queries differently?

2. **Named graph routing**: The SPARQL `FROM <urn:insurance:bindings>` syntax is used to select the bindings named graph. Should the rewriter intercept `GRAPH <urn:insurance:abox:asserted>` patterns and redirect them to SQL, while passing `GRAPH <urn:insurance:tbox:ontology>` patterns to Fuseki?

3. **Result set reconciliation**: SPARQL returns variables as typed RDF terms (IRI, literal, blank node). SQL returns typed relational values. Date formatting, numeric precision, and string encoding may differ between ground truth SQL results and rewritten SQL results.

4. **Federation**: Cross-dataset queries (e.g. insurance claims joined with public-health demographics) require either a federated SQL query (across schemas/databases) or a SPARQL federated query. The current architecture does not support this.

5. **Caching**: R2RML bindings are stored in Fuseki (`urn:insurance:bindings`). The rewriter should cache the parsed binding metadata in memory between requests rather than re-querying Fuseki on every translation.

---

## 8. Decision: Scope for This Codebase

For the unconcealment project, the SPARQL-to-SQL rewriter will be implemented as a TypeScript module in `services/indexing/` (alongside `rdf-binding.ts`), invoked at LLM prompt-generation time to provide SQL context. It is **not** a general-purpose SPARQL endpoint proxy — it is a context builder that translates the user's semantic intent (SPARQL pattern) to the SQL dialect appropriate for each dataset's storage backend.

The initial implementation (Phase 1) covers the most common benchmark question types. Phases 2–4 are tracked as future work.
