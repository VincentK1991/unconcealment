# Insurance Domain — ACME P&C Benchmark

> **Dataset ID**: `insurance`
> **Source**: [`datadotworld/cwd-benchmark-data`](https://github.com/datadotworld/cwd-benchmark-data)
> **Type**: Structured data (BigQuery) — no unstructured PDF pipeline at this stage
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

The relational schema is defined in `ACME_Insurance/DDL/ACME_small.ddl`. The 13 tables loaded into BigQuery are:

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
| **Settlement Time** | `DATE_DIFF(claim_close_date, claim_open_date, DAY)` |

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

## 4. Data Setup (BigQuery)

The ACME Insurance data is **not** a BigQuery public dataset. You must upload the CSV files to your own GCP project.

### Step 1 — Download CSV files

```bash
git clone https://github.com/datadotworld/cwd-benchmark-data.git
ls cwd-benchmark-data/ACME_Insurance/data/*.csv
# 28 CSV files — 13 core tables + specialized sub-tables
```

### Step 2 — Create BigQuery dataset

```bash
export GCP_PROJECT=your-project-id

bq mk --dataset ${GCP_PROJECT}:acme_insurance
```

### Step 3 — Load tables

Use the DDL schema from `ACME_Insurance/DDL/ACME_small.ddl` for column types. Example for the core tables:

```bash
DATA_DIR=cwd-benchmark-data/ACME_Insurance/data

# Core entity tables
bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.policy ${DATA_DIR}/Policy.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.claim ${DATA_DIR}/Claim.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.catastrophe ${DATA_DIR}/Catastrophe.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.policy_coverage_detail ${DATA_DIR}/Policy_Coverage_Detail.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.claim_coverage ${DATA_DIR}/Claim_Coverage.csv

# Financial tables
bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.claim_amount ${DATA_DIR}/Claim_Amount.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.loss_payment ${DATA_DIR}/Loss_Payment.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.loss_reserve ${DATA_DIR}/Loss_Reserve.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.expense_payment ${DATA_DIR}/Expense_Payment.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.expense_reserve ${DATA_DIR}/Expense_Reserve.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.policy_amount ${DATA_DIR}/Policy_Amount.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.premium ${DATA_DIR}/Premium.csv

bq load --autodetect --source_format=CSV \
  ${GCP_PROJECT}:acme_insurance.agreement_party_role ${DATA_DIR}/Agreement_Party_Role.csv
```

### Step 4 — Update manifest

Edit `ontology/manifest.yaml`, insurance dataset entry:

```yaml
bigquery:
  enabled: true
  project: your-project-id   # ← replace this
  dataset: acme_insurance
```

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

The `ontology/insurance/bindings.ttl` file is an **R2RML binding layer** that connects the insurance OWL ontology to the BigQuery relational schema. It follows the W3C R2RML Recommendation (`http://www.w3.org/ns/r2rml#`).

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
LLM generates BigQuery SQL
       │
       ▼
BigQuery executes SQL against acme_insurance dataset
```

### SQL Template Variables

SQL examples in `bindings.ttl` use two template variables that are resolved at query time from `manifest.yaml`:

| Variable | Manifest key | Example value |
|---|---|---|
| `{project}` | `bigquery.project` | `my-gcp-project` |
| `{dataset}` | `bigquery.dataset` | `acme_insurance` |

A fully resolved SQL example looks like:
```sql
SELECT COUNT(*) AS NoOfClaims
FROM `my-gcp-project.acme_insurance.claim`
```

### Adding This Framework to a Future Dataset

To add R2RML bindings to any new dataset:
1. Create `ontology/{id}/bindings.ttl` with R2RML TriplesMap definitions
2. Add `bindingsPath: ontology/{id}/bindings.ttl` to the manifest entry
3. Add `bigquery.project` and `bigquery.dataset` to the manifest entry
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

The 44 SQL queries in `bindings.ttl` are the ground truth answers, adapted for BigQuery syntax (backtick-quoted fully qualified table names, `EXTRACT(YEAR FROM ...)` instead of `YEAR(...)`).

To run a benchmark question end-to-end:
1. Present the natural language question to the LLM with `buildRdfBindingContext('insurance', backendUrl)` as context
2. LLM generates BigQuery SQL
3. Execute against `{project}.acme_insurance`
4. Compare result against the ground truth SQL result from `acme-benchmark.ttl`
