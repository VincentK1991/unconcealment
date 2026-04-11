# SPARQL→SQL Benchmark Runbook (Current As-Built)

Date: 2026-04-10  
Scope: `ACME_Insurance` benchmark (`44` inquiry pairs)

## Current Status

- Command:
  - `cd services/backend && mvn test -Dtest=OntopBenchmarkTest -Dgroups=integration`
- Latest result:
  - `Tests run: 44, Failures: 0, Errors: 0, Skipped: 1`
- Skip reason:
  - `DATE_DIFF` is not available in local Postgres, so DATE_DIFF-based inquiry is intentionally skipped.

## Where This Is Implemented

- Test harness:
  - `services/backend/src/test/java/com/unconcealment/backend/OntopBenchmarkTest.java`
- SPARQL normalization / translation path:
  - `services/backend/src/main/java/com/unconcealment/backend/service/OntopVkgService.java`

## How It Currently Works

1. Parse benchmark pairs from TTL
- Source TTL: `data/cwd-benchmark-data/ACME_Insurance/investigation/acme-benchmark.ttl`
- For each `QandA:Inquiry`, load paired SPARQL and SQL (`QandA:expects`), and run as one parameterized test case.

2. Execute against local Postgres benchmark DB
- JDBC target: `jdbc:postgresql://localhost:5433/kg` (`admin/test1234`)
- Test sets `search_path` to `acme_insurance, public`.

3. Translate SPARQL with Ontop
- Uses Ontop executable query extraction from `NativeNode` SQL.
- Pre-translation normalization:
  - Strip `SERVICE ... {}` wrapper used by benchmark prompts.
  - Ensure missing `rdf:` prefix only when needed.
  - Normalize bare date literals (`'YYYY-MM-DD'` or `"YYYY-MM-DD"`) to `xsd:dateTime` in SPARQL filters.
  - Ensure `xsd:` prefix if typed literals are injected.

4. Normalize benchmark SQL (ground truth) before execution
- Strip `#` comment lines that are invalid in Postgres SQL parsing.
- Rewrite `DATE_DIFF(...)` pattern to Postgres date subtraction form.
- Rewrite known invalid benchmark join pattern (`policy_amount.policy_identifier`) to schema-valid join through `policy_coverage_detail`.

5. Result-set comparison logic
- Execute Ontop SQL and ground-truth SQL.
- Normalize values:
  - Numeric values and numeric strings canonicalized via `BigDecimal`.
  - Timestamps canonicalized to `yyyy-MM-dd'T'HH:mm:ss`.
  - Dates to `yyyy-MM-dd`.
  - `NULL` as `<NULL>`.
- Compare row sets order-independently (sorted rows).
- Column alignment behavior:
  - If Ontop returns extra helper/provenance columns, align expected columns to a subset/permutation of Ontop columns by value-signature matching.
  - If only column order differs, reorder before compare.

## Why These Adjustments Were Needed

- Raw benchmark SQL includes dialect/schema artifacts not directly executable on local Postgres.
- Ontop SQL frequently includes extra internal columns not part of the user-level projection.
- Some benchmark SPARQL date filters use untyped string literals that can collapse to empty result under strict typing.

## Limitations / Tradeoffs

1. One inquiry is skipped
- DATE_DIFF inquiry is skipped unless the Postgres function exists.

2. Harness is projection-tolerant
- The test allows Ontop extra columns when expected columns can be matched by exact value signatures.
- This is intentional to avoid false failures from internal helper columns.
- Tradeoff: this does not enforce “exact projected column list” equality.

3. Benchmark SQL normalization is benchmark-specific
- Join and DATE_DIFF rewrites are targeted to known `acme-benchmark.ttl` patterns.
- If benchmark SQL text changes, rewrite rules may need updates.

4. This validates semantic equivalence on current local dataset
- Pass means equivalence against current loaded Postgres benchmark data and current ontology/OBDA/bindings.
- If data/mappings change, rerun and re-verify.

## Operational Notes

Prereqs:
- Local Postgres benchmark DB up on `localhost:5433`.
- Insurance ontology/mapping files present under `ontology/insurance`.

Run:
- `cd services/backend && mvn test -Dtest=OntopBenchmarkTest -Dgroups=integration`

If failures recur:
1. Check if failure is true semantic mismatch vs harness/input artifact.
2. Inspect failing prompt, Ontop SQL, and ground-truth SQL in surefire report.
3. Validate source tables with `psql` and confirm mapping predicates in `ontology/insurance/ontop.obda`.
