# Insurance Domain — ACME P&C Benchmark

> **Dataset ID**: `insurance`
> **Source**: [`datadotworld/cwd-benchmark-data`](https://github.com/datadotworld/cwd-benchmark-data)
> **Type**: Structured data (PostgreSQL, `acme_insurance` schema) — no unstructured PDF pipeline at this stage
> **Benchmark**: 44 natural language questions with paired SQL + SPARQL ground truth answers

---

## 1. Overview

The ACME Insurance dataset is a **Property & Casualty (P&C) insurance benchmark** designed to evaluate natural language-to-SQL and natural language-to-SPARQL systems. It models a realistic insurance company with policies, claims, agents, policy holders, premium amounts, and catastrophe events.

The dataset ships three artifacts used directly in this system:

| Artifact | Source file | Unconcealment path |
|---|---|---|
| OWL Ontology | `ACME_Insurance/ontology/insurance.ttl` | `ontology/insurance/core.ttl` |
| R2RML Mappings | `ACME_Insurance/data/data.world_P&C_Insurance_Ontology_V1.r2rml` | `ontology/insurance/bindings.ttl` (adapted) |
| Benchmark questions | `ACME_Insurance/investigation/acme-benchmark.ttl` | SQL examples embedded in `bindings.ttl` |

The ontology namespace `http://data.world/schema/insurance/` (prefix `in:`) is preserved **verbatim** to ensure the 44 benchmark SPARQL queries run against the Fuseki `insurance` dataset without modification.

---

## 2. Schema — 13 Core Tables

The relational schema is defined in `ACME_Insurance/DDL/ACME_small.ddl`. The 13 tables loaded into PostgreSQL (`acme_insurance` schema) are:

### Primary Entities

| Table | Primary Key | Description |
|---|---|---|
| `policy` | `policy_identifier` | Insurance policies with effective/expiration dates and policy numbers |
| `claim` | `claim_identifier` | Claims identified by `company_claim_number`, with open/close dates |
| `catastrophe` | `catastrophe_identifier` | Catastrophic events (hurricane, earthquake, flood, etc.) |
| `policy_coverage_detail` | `policy_coverage_detail_identifier` | Coverage lines within a policy — the pivot between policies and claims |

### Financial Detail Tables

| Table | Primary Key | Description |
|---|---|---|
| `policy_amount` | `policy_amount_identifier` | Raw premium amount rows per coverage detail |
| `premium` | `policy_amount_identifier` (FK) | Premium view derived from `policy_amount` |
| `claim_amount` | `claim_amount_identifier` | Abstract financial row per claim (dispatched to sub-tables below) |
| `loss_payment` | `claim_amount_identifier` (FK) | Actual loss payments disbursed |
| `loss_reserve` | `claim_amount_identifier` (FK) | Reserved (anticipated) loss amounts |
| `expense_payment` | `claim_amount_identifier` (FK) | Actual expense payments (legal, adjusting, etc.) |
| `expense_reserve` | `claim_amount_identifier` (FK) | Reserved expense amounts |

### Relationship / Party Tables

| Table | Primary Key | Description |
|---|---|---|
| `agreement_party_role` | `(agreement_identifier, party_identifier, party_role_code)` | Links parties to policies. `party_role_code = 'AG'` → Agent; `'PH'` → PolicyHolder |
| `claim_coverage` | `(claim_identifier, policy_coverage_detail_identifier)` | Join table: Claim ↔ PolicyCoverageDetail |

### Join Key Graph

```
policy ──────────────── policy_coverage_detail ──── claim_coverage ──── claim
  │ (policy_identifier)   (policy_coverage_detail_identifier)              │
  │                                │                                       │
  │                         policy_amount                         claim_amount
  │                                │                              /    |    \    \
agreement_party_role          premium                    loss_  loss_  expense_ expense_
  (role='AG' → Agent)                                   payment reserve payment  reserve
  (role='PH' → PolicyHolder)
                                                          catastrophe ────────────────┘
                                                          (via catastrophe_identifier)
```

### Key Calculations

| Metric | Formula |
|---|---|
| **Total Loss** | `loss_payment + loss_reserve + expense_payment + expense_reserve` |
| **Loss Ratio** | `Total Loss / Premium Amount` |
| **Settlement Time** | `(claim_close_date::date - claim_open_date::date)` (PostgreSQL interval arithmetic) |

---

## 3. Ontology

The ontology (`ontology/insurance/core.ttl`) uses namespace `http://data.world/schema/insurance/` and defines 11 classes:

| Class | Mapped from |
|---|---|
| `in:Policy` | `policy` table |
| `in:Claim` | `claim` table |
| `in:Catastrophe` | `catastrophe` table |
| `in:PolicyCoverageDetail` | `policy_coverage_detail` table |
| `in:Premium` | `premium` + `policy_amount` tables |
| `in:LossPayment` | `loss_payment` + `claim_amount` join |
| `in:LossReserve` | `loss_reserve` + `claim_amount` join |
| `in:ExpensePayment` | `expense_payment` + `claim_amount` join |
| `in:ExpenseReserve` | `expense_reserve` + `claim_amount` join |
| `in:Agent` | `agreement_party_role WHERE party_role_code = 'AG'` |
| `in:PolicyHolder` | `agreement_party_role WHERE party_role_code = 'PH'` |

Key object properties: `in:against` (Claim → PolicyCoverageDetail), `in:soldByAgent` (Policy → Agent), `in:hasPolicyHolder` (Policy → PolicyHolder), `in:hasLossPayment/Reserve`, `in:hasExpensePayment/Reserve`, `in:hasPremiumAmount`.

**Namespace preservation**: The `in:` namespace is never aliased to the project's `ex:` namespace. This ensures all 44 benchmark SPARQL queries are directly executable against Fuseki.

---

## 4. Data Setup (PostgreSQL)

The ACME Insurance data is loaded into the existing `postgres-kg` PostgreSQL instance under the `acme_insurance` schema. No additional infrastructure is required.

### Step 1 — Download CSV files

```bash
git clone https://github.com/datadotworld/cwd-benchmark-data.git
ls cwd-benchmark-data/ACME_Insurance/data/*.csv
# 13 core CSV files (one per table)
```

### Step 2 — Start postgres-kg (schema auto-created)

The `postgres-kg` container runs `infra/postgres/init-insurance.sql` on first start via `docker-entrypoint-initdb.d`. This creates the `acme_insurance` schema and all 13 tables with proper FK constraints and indexes.

```bash
docker compose up -d postgres-kg
```

### Step 3 — Load CSVs (follow FK insertion order)

Connect with `psql` and use `\copy` to load data. FK constraints require loading parent tables before child tables:

```sql
-- 1. No dependencies
\copy acme_insurance.catastrophe          FROM 'Catastrophe.csv'          CSV HEADER;
\copy acme_insurance.policy               FROM 'Policy.csv'               CSV HEADER;

-- 2. Depends on policy
\copy acme_insurance.policy_coverage_detail FROM 'Policy_Coverage_Detail.csv' CSV HEADER;
\copy acme_insurance.agreement_party_role  FROM 'Agreement_Party_Role.csv'  CSV HEADER;

-- 3. Depends on catastrophe
\copy acme_insurance.claim                FROM 'Claim.csv'                CSV HEADER;

-- 4. Depends on policy_coverage_detail
\copy acme_insurance.policy_amount        FROM 'Policy_Amount.csv'        CSV HEADER;

-- 5. Depends on policy_amount
\copy acme_insurance.premium              FROM 'Premium.csv'              CSV HEADER;

-- 6. Depends on claim + policy_coverage_detail
\copy acme_insurance.claim_coverage       FROM 'Claim_Coverage.csv'       CSV HEADER;

-- 7. Depends on claim
\copy acme_insurance.claim_amount         FROM 'Claim_Amount.csv'         CSV HEADER;

-- 8. Depends on claim_amount
\copy acme_insurance.loss_payment         FROM 'Loss_Payment.csv'         CSV HEADER;
\copy acme_insurance.loss_reserve         FROM 'Loss_Reserve.csv'         CSV HEADER;
\copy acme_insurance.expense_payment      FROM 'Expense_Payment.csv'      CSV HEADER;
\copy acme_insurance.expense_reserve      FROM 'Expense_Reserve.csv'      CSV HEADER;
```

### Step 4 — Verify row counts

```sql
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname = 'acme_insurance'
ORDER BY tablename;
```

### Step 5 — Manifest is already configured

The `ontology/manifest.yaml` insurance entry already has the correct `postgres` config:

```yaml
postgres:
  enabled: true
  schema: acme_insurance
```

No changes needed unless you use a different schema name.

---

## 5. Connecting to the RDF Store

### Named Graphs Created at Startup

When the backend starts with the insurance entry in `manifest.yaml`, it auto-creates the Fuseki `insurance` dataset and loads two named graphs:

| Named Graph | Contents | Source |
|---|---|---|
| `urn:insurance:tbox:ontology` | OWL ontology (11 classes, 10 object properties, 16 data properties) | `ontology/insurance/core.ttl` |
| `urn:insurance:bindings` | R2RML TriplesMap definitions + SQL query examples | `ontology/insurance/bindings.ttl` |

No rules graphs are created at this stage (`urn:insurance:tbox:rules:forward` / `backward` remain empty).

### Querying the Ontology via SPARQL

List all insurance classes:

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?class ?label
FROM <urn:insurance:tbox:ontology>
WHERE {
  ?class a owl:Class ;
         rdfs:label ?label .
}
ORDER BY ?label
```

List all object properties:

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?prop ?domain ?range
FROM <urn:insurance:tbox:ontology>
WHERE {
  ?prop a owl:ObjectProperty .
  OPTIONAL { ?prop rdfs:domain ?domain }
  OPTIONAL { ?prop rdfs:range ?range }
}
```

### Querying the R2RML Bindings via SPARQL

List all TriplesMaps with their descriptions:

```sparql
PREFIX rr:   <http://www.w3.org/ns/r2rml#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?map ?label ?description
FROM <urn:insurance:bindings>
WHERE {
  ?map a rr:TriplesMap ;
       rdfs:label ?label .
  OPTIONAL { ?map rdfs:comment ?description }
}
ORDER BY ?label
```

List all query examples:

```sparql
PREFIX rr:   <http://www.w3.org/ns/r2rml#>
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?mapLabel ?exLabel ?sql
FROM <urn:insurance:bindings>
WHERE {
  ?map a rr:TriplesMap ;
       rdfs:label ?mapLabel ;
       ex:queryExample ?ex .
  ?ex rdfs:label ?exLabel ;
      ex:sql ?sql .
}
ORDER BY ?mapLabel ?exLabel
```

These queries run against the Java backend's `POST /query/tbox` endpoint (no inference needed for binding metadata).

---

## 6. R2RML to SQL Framework

The `ontology/insurance/bindings.ttl` file is an **R2RML binding layer** that connects the insurance OWL ontology to the PostgreSQL relational schema. It follows the W3C R2RML Recommendation (`http://www.w3.org/ns/r2rml#`).

### How It Works

```
bindings.ttl (R2RML)
       │
       ▼  loaded at startup by OntologyLoaderService
urn:insurance:bindings  (Fuseki named graph)
       │
       ▼  queried at LLM invocation time via POST /query/tbox
rdf-binding.ts  →  buildRdfBindingContext('insurance', backendUrl)
       │
       ▼  appended to LLM prompt
LLM generates PostgreSQL SQL
       │
       ▼
postgres-kg executes SQL against acme_insurance schema
```

### SQL Template Variables

SQL examples in `bindings.ttl` use a template variable resolved at query time from `manifest.yaml`:

| Variable | Manifest key | Example value |
|---|---|---|
| `{schema}` | `postgres.schema` | `acme_insurance` |

A fully resolved SQL example looks like:
```sql
SELECT COUNT(*) AS NoOfClaims
FROM acme_insurance.claim
```

### Adding This Framework to a Future Dataset

To add R2RML bindings to any new dataset:
1. Create `ontology/{id}/bindings.ttl` with R2RML TriplesMap definitions
2. Add `bindingsPath: ontology/{id}/bindings.ttl` to the manifest entry
3. Add `postgres.schema` (or `bigquery.project`/`bigquery.dataset`) to the manifest entry
4. The backend auto-loads the file into `urn:{id}:bindings` — no code changes needed
5. Call `buildRdfBindingContext(datasetId, backendUrl)` from the indexing pipeline

---

## 7. Benchmark Validation

The benchmark defines 44 natural language questions, each with a paired SQL answer and SPARQL answer. Ground truth is in `ACME_Insurance/investigation/acme-benchmark.ttl`.

### SPARQL Benchmark Notes

The benchmark's SPARQL queries use a data.world-specific `SERVICE` wrapper:
```sparql
SERVICE ds-omg-pc-database:mapped { ... }
```

In our system, RDF entities extracted from BigQuery are asserted directly into `urn:insurance:abox:asserted`. Remove the `SERVICE` wrapper and query directly:

```sparql
# Benchmark original (data.world specific):
SELECT (count(?policy) as ?NoOfPolicy)
WHERE {
  SERVICE :mapped {
    ?policy rdf:type in:Policy.
  }
}

# Unconcealment equivalent:
PREFIX in: <http://data.world/schema/insurance/>
SELECT (COUNT(?policy) AS ?NoOfPolicy)
FROM <urn:insurance:abox:asserted>
WHERE {
  ?policy a in:Policy .
}
```

### SQL Benchmark

The 44 SQL queries in `bindings.ttl` are the ground truth answers, adapted for PostgreSQL syntax (schema-qualified table names `{schema}.tablename`, interval arithmetic `(close_date::date - open_date::date)` instead of `DATE_DIFF`).

To run a benchmark question end-to-end:
1. Present the natural language question to the LLM with `buildRdfBindingContext('insurance', backendUrl)` as context
2. LLM generates PostgreSQL SQL
3. Execute against `postgres-kg` (schema `acme_insurance`) — use the web SQL tab at `/dataset/insurance/sql`
4. Compare result against the ground truth SQL result from `acme-benchmark.ttl`
