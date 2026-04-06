# CMS Medicare — EDA Findings

**Dataset**: `bigquery-public-data.cms_medicare`
**Focus tables**: `hospital_general_info`, `inpatient_charges_2015`
**Granularity**: Hospital (provider) level
**Source**: Centers for Medicare & Medicaid Services

---

## Available Tables

| Table | Years | Description |
|---|---|---|
| `hospital_general_info` | Current | Hospital directory — name, location, type, star rating, quality benchmarks |
| `inpatient_charges_2011`–`2015` | 2011–2015 | DRG procedure costs per hospital (latest: 2015) |
| `outpatient_charges_2011`–`2015` | 2011–2015 | Outpatient procedure costs per hospital |
| `physicians_and_other_supplier_2012`–`2015` | 2012–2015 | Provider-level billing: specialty, procedure count, payments |
| `part_d_prescriber_2014` | 2014 | Drug prescribing patterns by provider |
| `nursing_facilities_2013`–`2014` | 2013–2014 | Nursing home quality ratings |
| `home_health_agencies_2013`–`2014` | 2013–2014 | Home health agency quality data |

---

## `hospital_general_info` — Hospital Directory

### Schema
| Column | Type | Description |
|---|---|---|
| `provider_id` | STRING | CMS Certification Number (CCN) — stable, nationally unique hospital ID |
| `hospital_name` | STRING | Hospital name — **unstructured text** |
| `address` | STRING | Street address — **unstructured text** |
| `city` | STRING | City |
| `state` | STRING | 2-letter state code |
| `zip_code` | STRING | ZIP code (use for county-level geographic join) |
| `county_name` | STRING | County name (text, not FIPS) |
| `phone_number` | STRING | Phone number |
| `hospital_type` | STRING | E.g. `"Acute Care Hospitals"`, `"Critical Access Hospitals"` |
| `hospital_ownership` | STRING | E.g. `"Voluntary non-profit - Private"`, `"Government - Local"` |
| `emergency_services` | BOOLEAN | Whether hospital has emergency services |
| `hospital_overall_rating` | STRING | Star rating 1–5; `"Not Available"` when insufficient data |
| `mortality_measures_better_count` | STRING | Number of mortality measures better than national |
| `mortality_measures_worse_count` | STRING | Number of mortality measures worse than national |
| `safety_measures_better_count` | STRING | Number of safety measures better than national |
| `readmission_measures_better_count` | STRING | Number of readmission measures better than national |
| `readmission_measures_worse_count` | STRING | Number of readmission measures worse than national |
| `patient_experience_measures_count` | STRING | Count of patient experience measures |

**Data quality note**: Many columns use `"Not Available"` as a STRING instead of NULL — cast carefully.

### Why hospitals are mintable RDF entities
`provider_id` (CMS CCN) is a stable, government-issued unique identifier. Each hospital warrants its own IRI:
```
http://localhost:4321/entity/{uuid}
  owl:sameAs <https://data.cms.gov/provider/{provider_id}>
  ex:cmsProviderID "010018"
  ex:hospitalName "CALLAHAN EYE HOSPITAL"
  ex:inRegion <http://localhost:4321/entity/{county-uuid}>
```
This makes hospitals first-class graph entities, with their full profile accessible via the semantic binding layer.

### Sample Rows
| provider_id | hospital_name | city | state | hospital_type | hospital_overall_rating |
|---|---|---|---|---|---|
| 010018 | CALLAHAN EYE HOSPITAL | BIRMINGHAM | AL | Acute Care Hospitals | Not Available |
| 010051 | GREENE COUNTY HOSPITAL | EUTAW | AL | Acute Care Hospitals | Not Available |
| 010102 | J PAUL JONES HOSPITAL | CAMDEN | AL | Acute Care Hospitals | Not Available |

---

## `inpatient_charges_2015` — DRG Procedure Costs

### Schema
| Column | Type | Description |
|---|---|---|
| `provider_id` | STRING | CMS CCN — joins to hospital_general_info |
| `provider_name` | STRING | Hospital name |
| `provider_street_address` | STRING | Street address |
| `provider_city` | STRING | City |
| `provider_state` | STRING | 2-letter state code |
| `provider_zipcode` | STRING | ZIP code |
| `drg_definition` | STRING | **UNSTRUCTURED TEXT**: DRG code + procedure description (see below) |
| `hospital_referral_region_description` | STRING | Hospital Referral Region name (e.g. `"AL - Birmingham"`) |
| `total_discharges` | INTEGER | Number of Medicare discharges for this DRG at this hospital |
| `average_covered_charges` | FLOAT | Hospital's average billed charges to Medicare ($) |
| `average_total_payments` | FLOAT | Average total payment including patient co-pay ($) |
| `average_medicare_payments` | FLOAT | Average Medicare payment (excludes patient cost-sharing) ($) |

### `drg_definition` — The Unstructured Content
This is the richest free-text field in any of the health datasets. Each value is a DRG code + clinical description:

```
"001 - HEART TRANSPLANT OR IMPLANT OF HEART ASSIST SYSTEM W MCC"
"003 - ECMO OR TRACH W MV >96 HRS OR PDX EXC FACE, MOUTH & NECK W MAJ O.R."
"194 - SIMPLE PNEUMONIA & PLEURISY W CC"
"470 - MAJOR JOINT REPLACEMENT OR REATTACHMENT OF LOWER EXTREMITY W/O MCC"
"871 - SEPTICEMIA OR SEVERE SEPSIS W/O MV >96 HOURS W MCC"
```

**What this enables**:
- LLM extraction can parse `drg_definition` to build a `MedicalProcedure` class hierarchy in the ontology
- Severity suffixes (`W MCC` = with major complication, `W CC` = with complication, `W/O MCC` = without) encode clinical nuance
- Price variation for the same DRG across hospitals/states is a healthcare access inequality signal

### Sample Cost Comparison (2015)
| DRG | State | Avg Billed | Avg Medicare Payment |
|---|---|---|---|
| Heart Transplant | CA | $1,727,046 | $336,733 |
| Heart Transplant | PA | $1,581,216 | $218,622 |
| Heart Transplant | AL | $1,014,783 | $141,194 |

The gap between billed charges and Medicare payment reveals cost-shifting patterns.

---

## High-Value Query Patterns

**Hospital quality: find hospitals with more-worse-than-better mortality measures:**
```sql
SELECT provider_id, hospital_name, city, state,
  hospital_overall_rating,
  CAST(mortality_measures_worse_count AS INT64) AS mortality_worse,
  CAST(mortality_measures_better_count AS INT64) AS mortality_better
FROM `bigquery-public-data.cms_medicare.hospital_general_info`
WHERE mortality_measures_worse_count NOT IN ('Not Available', 'NULL')
  AND CAST(mortality_measures_worse_count AS INT64) >
      CAST(mortality_measures_better_count AS INT64)
ORDER BY mortality_worse DESC
LIMIT 20
```

**DRG cost variation by state for a common procedure:**
```sql
SELECT provider_state,
  COUNT(DISTINCT provider_id) AS hospital_count,
  AVG(average_covered_charges) AS avg_billed,
  AVG(average_medicare_payments) AS avg_medicare_paid,
  AVG(average_covered_charges) / AVG(average_medicare_payments) AS markup_ratio
FROM `bigquery-public-data.cms_medicare.inpatient_charges_2015`
WHERE drg_definition LIKE '%SEPTICEMIA%'
GROUP BY provider_state
ORDER BY markup_ratio DESC
```

**Join hospital info to charges to get quality + cost together:**
```sql
SELECT h.hospital_name, h.city, h.state, h.hospital_overall_rating,
  c.drg_definition,
  c.average_covered_charges,
  c.average_medicare_payments
FROM `bigquery-public-data.cms_medicare.inpatient_charges_2015` c
JOIN `bigquery-public-data.cms_medicare.hospital_general_info` h
  ON c.provider_id = h.provider_id
WHERE h.state = @state
  AND c.drg_definition LIKE '%JOINT REPLACEMENT%'
ORDER BY c.average_covered_charges DESC
```

**Cross-dataset: join CMS hospital density to AHR uninsured rate by state:**
```sql
SELECT
  ahr.state_name,
  ahr.value AS uninsured_pct,
  COUNT(h.provider_id) AS hospital_count,
  SUM(CASE WHEN h.emergency_services THEN 1 ELSE 0 END) AS er_hospitals
FROM `bigquery-public-data.america_health_rankings.ahr` ahr
JOIN `bigquery-public-data.cms_medicare.hospital_general_info` h
  ON ahr.state_name = (SELECT state_name FROM ...)  -- state name to 2-letter crosswalk
WHERE ahr.measure_name = 'Uninsured'
  AND ahr.subpopulation IS NULL
  AND ahr.edition = 2021
GROUP BY ahr.state_name, ahr.value
ORDER BY uninsured_pct DESC
```

---

## Notes
- `provider_id` is the join key across all CMS Medicare tables
- Latest inpatient/outpatient charges: 2015 — 10-year data gap is a limitation
- Many STRING columns use `"Not Available"` instead of NULL — always check before casting
- `hospital_overall_rating` stores `"1"` through `"5"` as strings — cast to INT64 for comparison
- No county FIPS in CMS data — county-level joins need ZIP→FIPS crosswalk
- `hospital_referral_region_description` (e.g. `"CA - Los Angeles"`) is an alternative geographic grouping used in healthcare analytics
