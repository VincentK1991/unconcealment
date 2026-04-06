# America's Health Rankings (AHR) — EDA Findings

**Dataset**: `bigquery-public-data.america_health_rankings`
**Table**: `ahr`
**Granularity**: US State
**Latest year**: 2021 (Health Disparities report only in BigQuery)
**Source**: United Health Foundation — America's Health Rankings

---

## Schema

Long-format table. One row = one `(measure, state, subpopulation)` observation.

| Column | Type | Description |
|---|---|---|
| `edition` | INTEGER | Report year (2021) |
| `report_type` | STRING | Always `"2021 Health Disparities"` in this table |
| `measure_name` | STRING | Name of the health or social measure (see catalogue below) |
| `state_name` | STRING | US state name (e.g. `"Mississippi"`, `"California"`) |
| `subpopulation` | STRING | Demographic group; NULL = overall/all populations |
| `value` | FLOAT | Measure value (units vary per measure — see catalogue) |
| `lower_ci` | FLOAT | Lower bound of 95% confidence interval |
| `upper_ci` | FLOAT | Upper bound of 95% confidence interval |
| `source` | STRING | Data source citation (e.g. `"CDC, Behavioral Risk Factor Surveillance System"`) |
| `source_date` | STRING | Reference period of source data (e.g. `"2019"`, `"2015-2019"`) |

**Key insight**: `source` and `source_date` are provenance fields embedded in the data — rare for a BigQuery dataset. These map naturally to RDF-star provenance annotations.

---

## Measure Catalogue (2021)

### Health Outcomes
| Measure | Typical Unit | Notes |
|---|---|---|
| `Premature Death` | Years of potential life lost per 100k | Core mortality indicator |
| `Cancer` | % of adults ever diagnosed with cancer | |
| `Cardiovascular Diseases` | % of adults with heart disease/stroke | |
| `Diabetes` | % of adults diagnosed with diabetes | |
| `Multiple Chronic Conditions` | % of adults with 2+ chronic conditions | |
| `Infant Mortality` | Deaths per 1,000 live births | Some states suppressed |
| `Maternal Mortality` | Deaths per 100k live births | Sparse data |
| `Low Birthweight` | % of births below 2,500g | |

### Health Behaviors
| Measure | Typical Unit |
|---|---|
| `Smoking` | % of adults who smoke |
| `Physical Inactivity` | % of adults physically inactive |
| `Excessive Drinking` | % of adults who drink excessively |
| `Flu Vaccination` | % of adults vaccinated for flu |

### Mental & Social Health
| Measure | Typical Unit |
|---|---|
| `Frequent Mental Distress` | % of adults with 14+ poor mental health days/month |
| `Depression` | % of adults diagnosed with depression |
| `Food Insecurity` | % of population food insecure |
| `Severe Housing Problems` | % of households with housing problems |

### Healthcare Access
| Measure | Typical Unit |
|---|---|
| `Uninsured` | % of population without health insurance |
| `Avoided Care Due to Cost` | % who avoided care due to cost |
| `Dedicated Health Care Provider` | % with a personal doctor/provider |

### Social Determinants (links to ACS)
| Measure | Typical Unit | ACS Equivalent |
|---|---|---|
| `Poverty` | % below poverty line | ACS `poverty` / `total_pop` |
| `Unemployment` | % unemployed | ACS `unemployed_pop` / `civilian_labor_force` |
| `Income Inequality` | Gini coefficient | ACS `gini_index` |
| `Per Capita Income` | Dollars | ACS `income_per_capita` |
| `Less Than High School Education` | % without HS diploma | ACS `less_than_high_school_graduate` |
| `Child Poverty` | % of children in poverty | ACS income brackets |
| `Residential Segregation` | Index score | No direct ACS equivalent |

### Other
| Measure | Notes |
|---|---|
| `Able-Bodied` | % of adults without disability |
| `Asthma` | % of adults with asthma |
| `Gender Pay Gap` | State-level only (52 rows) |
| `High Health Status` | % who report very good or excellent health |

---

## Subpopulation Breakdown

| Subpopulation | Description |
|---|---|
| NULL | Overall / all populations combined |
| `White` | Non-Hispanic White |
| `Black/African American` | |
| `Hispanic` | |
| `Asian/Pacific Islander` | |
| `American Indian/Alaska Native` | |
| `Other Race` | |
| `Multiracial` | |
| `Male` / `Female` | By gender |
| `High School Grad` / `Less Than High School` / `Some College` / `College Grad` | By education level |
| `Metropolitan Area` / `Non-Metropolitan Area` | By urbanicity |

**This is where it gets interesting**: for every measure + state combination, you get the value for each subpopulation. The gap between White and Black values for Premature Death, Diabetes, or Uninsured is a direct health disparity metric — and it links to the economic disparity measures in the Opportunity Atlas.

---

## High-Value Query Patterns

**States with highest racial gap in premature death:**
```sql
SELECT
  b.state_name,
  b.value AS black_premature_death,
  w.value AS white_premature_death,
  b.value - w.value AS racial_gap
FROM `bigquery-public-data.america_health_rankings.ahr` b
JOIN `bigquery-public-data.america_health_rankings.ahr` w
  ON b.state_name = w.state_name
  AND b.measure_name = w.measure_name
  AND b.edition = w.edition
WHERE b.measure_name = 'Premature Death'
  AND b.subpopulation = 'Black/African American'
  AND w.subpopulation = 'White'
  AND b.edition = 2021
ORDER BY racial_gap DESC
```

**All health measures for a specific state with confidence intervals:**
```sql
SELECT measure_name, subpopulation, value, lower_ci, upper_ci, source, source_date
FROM `bigquery-public-data.america_health_rankings.ahr`
WHERE state_name = @state_name
  AND edition = 2021
  AND subpopulation IS NULL
ORDER BY measure_name
```

**Cross-dataset: join AHR poverty to ACS income by state:**
```sql
SELECT
  acs.geo_id,
  acs.median_income,
  acs.gini_index AS acs_gini,
  ahr.value AS ahr_poverty_pct,
  ahr_pd.value AS premature_death_rate
FROM `bigquery-public-data.census_bureau_acs.state_2021_1yr` acs
JOIN `bigquery-public-data.america_health_rankings.ahr` ahr
  ON LOWER(REGEXP_EXTRACT(acs.geo_id, r'[A-Za-z ]+$')) = LOWER(ahr.state_name)
JOIN `bigquery-public-data.america_health_rankings.ahr` ahr_pd
  ON ahr.state_name = ahr_pd.state_name
WHERE ahr.measure_name = 'Poverty'
  AND ahr.subpopulation IS NULL
  AND ahr_pd.measure_name = 'Premature Death'
  AND ahr_pd.subpopulation IS NULL
  AND ahr.edition = 2021
```

---

## Notes
- Only 2021 data is in BigQuery (`america_health_rankings.america_health_rankings` table has no schema)
- All 50 states + DC for most measures; some measures have sparse data (Maternal Mortality = 8 rows)
- State-level only — no county granularity in this dataset
- `value` is NULL for suppressed cells (small sample sizes) — check IS NOT NULL in queries
- Source citations make this dataset provenance-ready for RDF-star annotation
