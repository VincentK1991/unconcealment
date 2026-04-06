# Public Health EDA — Findings Overview

> **Purpose**: Identify BigQuery public datasets worth documenting in the semantic binding layer.
> Data stays in BigQuery — it is NOT ingested into the RDF store.
> These findings feed `ontology/public-health/bigquery-bindings.yaml`.

## Selected Tables

| Table | Dataset | Tier | Reason |
|---|---|---|---|
| `ahr` | `america_health_rankings` | 1 — Primary | 30+ health measures per state by race/gender/education; 2021 disparities data; source-cited |
| `hospital_general_info` | `cms_medicare` | 1 — Primary | Hospital directory — real-world entities (IRIs mintable); star ratings, quality benchmarks |
| `inpatient_charges_2015` | `cms_medicare` | 1 — Primary | DRG procedure costs per hospital; `drg_definition` is rich unstructured text |
| `outpatient_charges_2015` | `cms_medicare` | 2 — Secondary | Same structure as inpatient but for outpatient procedures |
| `physicians_and_other_supplier_2015` | `cms_medicare` | 2 — Secondary | Provider-level Medicare billing; links physicians to hospitals and specialties |

## Key Design Decisions

### Geographic classes: reuse from economic-census
`State`, `County` are defined in `ontology/economic-census/core.ttl`. The public-health ontology imports them via `owl:imports` rather than redefining. This enables cross-dataset queries like:
```sparql
# Counties with high poverty (ACS) AND high premature death (AHR)
SELECT ?county WHERE {
  ?county ex:medianIncome ?income ; ex:povertyRate ?poverty .
  ?healthMeasure ex:forGeography ?county ; ex:measureName "Premature Death" ; ex:value ?rate .
  FILTER(?poverty > 0.20 && ?income < 40000)
}
```

### AHR is long-format — different from ACS
ACS has one row per geography with 200+ columns. AHR has one row per `(measure, state, subpopulation)` triplet. This is semantically cleaner for RDF: each row is already almost a triple — `state --[measure]--> value`. The semantic binding layer captures this pattern explicitly.

### `drg_definition` is the unstructured content
CMS inpatient charges contain medical procedure descriptions as free text (e.g., `"HEART TRANSPLANT OR IMPLANT OF HEART ASSIST SYSTEM W MCC"`). This is the most genuine unstructured content found in any census/health BigQuery dataset. It can be indexed via the LLM extraction pipeline to build a medical procedure ontology.

### Hospitals are mintable entities
`hospital_general_info` provides `provider_id` (CMS Certification Number) — a stable, nationally-unique identifier. Hospitals are real-world entities that belong in the RDF store (as IRIs), with their BigQuery profile accessible via the semantic binding layer.

## Join Strategy

| From | To | Join Key |
|---|---|---|
| AHR state measures | ACS state data | `ahr.state_name` ↔ state name in ACS geo_id |
| CMS hospital | ACS county | `cms.zip_code` → county FIPS via ZIP-county crosswalk |
| CMS inpatient charges | hospital_general_info | `provider_id` (CMS CCN) |
| CMS hospital | AHR | `cms.state` ↔ `ahr.state_name` |

**Note**: CMS tables do not have FIPS codes. State-level joins are clean; county-level joins require a ZIP→FIPS crosswalk (not in BigQuery public data — needs external reference or geocoding).

## See Also
- [`america_health_rankings.md`](america_health_rankings.md) — AHR schema, measure catalogue, disparities breakdown
- [`cms_medicare.md`](cms_medicare.md) — CMS hospital directory, DRG cost schema, unstructured content notes
