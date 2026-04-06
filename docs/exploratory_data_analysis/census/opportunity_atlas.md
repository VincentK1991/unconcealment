# Opportunity Atlas — EDA Findings

**Dataset**: `bigquery-public-data.census_opportunity_atlas`
**Source**: Raj Chetty, John Friedman, Nathaniel Hendren, Maggie R. Jones, Sonya R. Porter (2018)
**Tables**: `tract_outcomes`, `tract_covariates`
**Granularity**: US Census Tract (~73,000 tracts)

This is the most semantically rich dataset in the census portfolio. It measures **intergenerational economic mobility** — where children end up financially based on where they grew up and their demographic group. No other public dataset provides this.

---

## `tract_outcomes` — Column Naming Codebook

Column names follow a strict pattern:
```
{outcome}_{race}_{gender}_{statistic}
```

### Outcome Codes
| Code | Full Name | Description |
|---|---|---|
| `kir` | Individual Income Rank | Child's individual income rank at age ~32 |
| `kfr` | Family Income Rank | Child's family income rank at age ~35 |
| `kfr_26` | Family Income Rank at 26 | Same but measured earlier (age 26) |
| `kir_26` | Individual Income Rank at 26 | Earlier measurement |
| `kfr_top20` | Top Quintile Probability | Probability child reaches top 20% income |
| `kir_top20` | Top Quintile (Individual) | Individual income version |
| `jail` | Incarceration Rate | Fraction incarcerated on April 1, 2010 |
| `married` | Marriage Rate | Fraction married in 2015 |
| `has_dad` | Father Presence | Fraction with father in household at age 13–18 |
| `teenbrth` | Teen Birth Rate | Fraction of women who had a child before age 20 |
| `working` | Employment Rate | Fraction working (W-2 income > 0) |

### Race Codes
| Code | Group |
|---|---|
| `natam` | Native American |
| `asian` | Asian |
| `black` | Black / African American |
| `hisp` | Hispanic |
| `white` | White non-Hispanic |
| `pooled` | All races combined |

### Gender Codes
| Code | Group |
|---|---|
| `male` | Male |
| `female` | Female |

### Statistic Codes
| Code | Meaning |
|---|---|
| `p1` | Mean outcome for children whose parents were at the **1st percentile** of income |
| `p25` | Mean outcome for children whose parents were at the **25th percentile** |
| `p50` | Mean outcome for children whose parents were at the **50th percentile** |
| `p75` | Mean outcome for children whose parents were at the **75th percentile** |
| `p100` | Mean outcome for children whose parents were at the **100th percentile** |
| `mean` | Mean outcome for all children in that group regardless of parent income |
| `n` | Sample size (number of children in that cell) |

### Example Interpretation
`kfr_black_female_p25 = 0.38` for a given tract means:
> Black women who grew up in this census tract with parents at the 25th income percentile have a mean family income rank of 38th percentile as adults.

### Key Derived Metric: Absolute Upward Mobility
The standard mobility metric used in Chetty et al. research:
```sql
-- Mean family income rank for children with parents at p25
-- Higher = more upward mobility from the bottom
kfr_pooled_pooled_p25
```

---

## `tract_covariates` — Structural Context

These are neighborhood characteristics that correlate with mobility outcomes.

### Geographic Identifiers
| Column | Type | Description |
|---|---|---|
| `state` | INTEGER | State FIPS code (e.g. 36 for NY) |
| `county` | INTEGER | County FIPS code within state (e.g. 79 for Rockland) |
| `tract` | INTEGER | Census tract number |
| `cz` | INTEGER | Commuting zone identifier |
| `czname` | STRING | Commuting zone name (e.g. "New York") — **only STRING field** |

### Economic Context
| Column | Type | Description |
|---|---|---|
| `hhinc_mean2000` | FLOAT | Mean household income in 2000 |
| `med_hhinc1990` | FLOAT | Median household income 1990 |
| `med_hhinc2016` | INTEGER | Median household income 2016 |
| `poor_share1990` | FLOAT | Poverty share 1990 |
| `poor_share2000` | FLOAT | Poverty share 2000 |
| `poor_share2010` | FLOAT | Poverty share 2010 |
| `emp2000` | FLOAT | Employment rate 2000 |
| `ann_avg_job_growth_2004_2013` | FLOAT | Annual average job growth rate 2004–2013 |
| `job_density_2013` | FLOAT | Jobs per square mile 2013 |
| `jobs_total_5mi_2015` | INTEGER | Total jobs within 5 miles 2015 |
| `jobs_highpay_5mi_2015` | INTEGER | High-paying jobs within 5 miles 2015 |
| `ln_wage_growth_hs_grad` | STRING | Log wage growth for high school graduates (stored as string) |

### Demographic Context
| Column | Type | Description |
|---|---|---|
| `share_black2010` | FLOAT | Share Black 2010 |
| `share_white2010` | FLOAT | Share white 2010 |
| `share_hisp2010` | FLOAT | Share Hispanic 2010 |
| `share_asian2010` | FLOAT | Share Asian 2010 |
| `foreign_share2010` | FLOAT | Foreign-born share 2010 |
| `singleparent_share1990` | FLOAT | Single-parent household share 1990 |
| `singleparent_share2000` | FLOAT | Single-parent household share 2000 |
| `singleparent_share2010` | FLOAT | Single-parent household share 2010 |
| `popdensity2000` | FLOAT | Population density 2000 |
| `popdensity2010` | FLOAT | Population density 2010 |

### Education & Infrastructure
| Column | Type | Description |
|---|---|---|
| `frac_coll_plus2000` | FLOAT | Fraction of adults with college degree+ 2000 |
| `frac_coll_plus2010` | FLOAT | Fraction of adults with college degree+ 2010 |
| `gsmn_math_g3_2013` | FLOAT | Mean 3rd grade math test scores 2013 (standardized) |
| `traveltime15_2010` | FLOAT | Fraction of commuters with < 15 min commute 2010 |
| `mean_commutetime2000` | FLOAT | Mean commute time 2000 |
| `rent_twobed2015` | INTEGER | Median 2-bedroom rent 2015 |
| `mail_return_rate2010` | FLOAT | Census mail return rate 2010 (proxy for civic engagement) |

---

## High-Value Query Patterns

**Which tracts have the highest upward mobility for Black children from low-income families?**
```sql
SELECT state, county, tract, kfr_black_pooled_p25
FROM `bigquery-public-data.census_opportunity_atlas.tract_outcomes`
WHERE kfr_black_pooled_p25 IS NOT NULL
ORDER BY kfr_black_pooled_p25 DESC
LIMIT 20
```

**Mobility gap between white and Black children in the same tract (parents at p25)?**
```sql
SELECT state, county, tract,
  kfr_white_pooled_p25,
  kfr_black_pooled_p25,
  kfr_white_pooled_p25 - kfr_black_pooled_p25 AS racial_gap
FROM `bigquery-public-data.census_opportunity_atlas.tract_outcomes`
WHERE kfr_white_pooled_p25 IS NOT NULL
  AND kfr_black_pooled_p25 IS NOT NULL
ORDER BY racial_gap DESC
LIMIT 20
```

**Join outcomes to structural covariates to understand what drives mobility:**
```sql
SELECT o.state, o.county, o.tract, c.czname,
  o.kfr_pooled_pooled_p25 AS upward_mobility,
  c.poor_share2010,
  c.frac_coll_plus2010,
  c.job_density_2013,
  c.singleparent_share2010
FROM `bigquery-public-data.census_opportunity_atlas.tract_outcomes` o
JOIN `bigquery-public-data.census_opportunity_atlas.tract_covariates` c
  ON o.state = c.state AND o.county = c.county AND o.tract = c.tract
WHERE o.kfr_pooled_pooled_p25 IS NOT NULL
ORDER BY upward_mobility DESC
LIMIT 50
```

---

## Notes
- Data covers children born roughly 1978–1983, observed as adults in their 30s
- `n` columns indicate sample size — treat estimates with `n < 20` with caution
- The only STRING column in `tract_covariates` is `czname` (commuting zone name)
- `ln_wage_growth_hs_grad` is stored as STRING despite being numeric — cast before use
