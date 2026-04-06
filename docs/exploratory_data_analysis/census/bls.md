# BLS Quarterly Census of Employment and Wages (QCEW) — EDA Findings

**Dataset**: `bigquery-public-data.bls_qcew`
**Coverage**: US counties, quarterly, 1990 Q1 – 2019 Q2 (latest in BigQuery)
**Tables**: one table per quarter — `{year}_q{1-4}` (e.g. `2019_q2`)
**Granularity**: County level (FIPS)

---

## Why This Dataset

ACS tells you *household* income and unemployment. QCEW tells you the **industrial composition of a local economy** — how many establishments, how many workers, and what wages each industry sector pays per county. Together they answer questions like:

> "Is this county's low median income because of high poverty or because of a low-wage industry mix?"
> "Which counties are over-represented in manufacturing vs. national average?"

---

## Schema Pattern

Every QCEW table follows the same schema. Columns are grouped by industry sector using NAICS codes:

```
{metric}_{naics_code}_{industry_name}
```

### Metrics per industry
| Metric prefix | Description |
|---|---|
| `qtrly_estabs_{sector}` | Number of establishments in the sector |
| `avg_wkly_wage_{sector}` | Average weekly wage ($) |
| `month3_emplvl_{sector}` | Employment level (3rd month of quarter) |
| `lq_qtrly_estabs_{sector}` | Location quotient of establishments |
| `lq_avg_wkly_wage_{sector}` | Location quotient of average weekly wage |
| `lq_month3_emplvl_{sector}` | Location quotient of employment level |

**Location Quotient (LQ)**: ratio of local industry share to national share. `lq > 1` means the county is more specialized in that industry than the US average. Useful for economic specialization analysis.

### Industry Sectors Covered (sample)
| NAICS | Sector Name |
|---|---|
| `11` | Agriculture, forestry, fishing and hunting |
| `21` | Mining, quarrying, oil and gas extraction |
| `22` | Utilities |
| `23` | Construction |
| `31-33` | Manufacturing |
| `42` | Wholesale trade |
| `44-45` | Retail trade |
| `48-49` | Transportation and warehousing |
| `51` | Information |
| `52` | Finance and insurance |
| `53` | Real estate and rental and leasing |
| `54` | Professional, scientific, and technical services |
| `61` | Educational services |
| `62` | Health care and social assistance |
| `71` | Arts, entertainment, and recreation |
| `72` | Accommodation and food services |
| `92` | Public administration |
| `1023` | Financial activities (super-sector aggregate) |
| `1024` | Professional and business services (aggregate) |
| `1025` | Education and health services (aggregate) |

### Join Key
| Column | Type | Description |
|---|---|---|
| `geoid` | STRING | 5-digit county FIPS (e.g. `"36079"`) — same as stripping ACS `geo_id` prefix |
| `area_fips` | STRING | Same as `geoid` — legacy duplicate column |

---

## Column Descriptions
Unlike ACS and Opportunity Atlas, **every QCEW column has a human-readable description in the BigQuery schema**. Example:

- `avg_wkly_wage_61_educational_services` → `"Average weekly wage for Educational services establishments"`
- `lq_month3_emplvl_11_agriculture_forestry_fishing_and_hunting` → `"Employment level location quotient in Agriculture, forestry, fishing and hunting establishments"`

These descriptions are the "unstructured adjacent" text that makes this dataset particularly useful for the LLM binding layer — the schema itself serves as a codebook.

---

## Temporal Coverage Note

Latest table in BigQuery: **2019 Q2**. This is a significant gap vs. ACS (2021). For current employment analysis, QCEW is best used for:
- Industry structure and specialization (changes slowly)
- Historical wage trend analysis (1990–2019)
- Cross-county comparison of industry mix

For current employment levels, ACS `employed_*` columns are more up to date.

---

## High-Value Query Patterns

**Which counties are most specialized in manufacturing (2019)?**
```sql
SELECT geoid,
  lq_month3_emplvl_31_33_manufacturing AS manufacturing_lq,
  avg_wkly_wage_31_33_manufacturing AS manufacturing_avg_wage,
  month3_emplvl_31_33_manufacturing AS manufacturing_employment
FROM `bigquery-public-data.bls_qcew.2019_q2`
WHERE lq_month3_emplvl_31_33_manufacturing IS NOT NULL
ORDER BY manufacturing_lq DESC
LIMIT 20
```

**Join QCEW wages to ACS income to find wage-income divergence:**
```sql
SELECT
  acs.geo_id,
  acs.median_income AS acs_median_household_income,
  qcew.avg_wkly_wage_1025_education_and_health_services * 52 AS edu_health_annual_wage,
  qcew.lq_month3_emplvl_62_health_care_and_social_assistance AS healthcare_employment_lq
FROM `bigquery-public-data.census_bureau_acs.county_2021_1yr` acs
JOIN `bigquery-public-data.bls_qcew.2019_q2` qcew
  ON SUBSTR(acs.geo_id, -5) = qcew.geoid
WHERE acs.total_pop > 50000
ORDER BY healthcare_employment_lq DESC
LIMIT 20
```

---

## Notes
- Tables are quarterly — use Q2 for most stable annual picture (Q4 skewed by seasonal retail)
- `area_fips` and `geoid` are the same column — use `geoid`
- Location quotients require national baseline — BLS computes them within the dataset
- Manufacturing and healthcare LQs are the most analytically useful for economic analysis
