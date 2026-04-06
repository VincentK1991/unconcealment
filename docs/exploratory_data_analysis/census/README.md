# Census EDA — Findings Overview

> **Purpose**: Identify BigQuery public datasets worth documenting in the semantic binding layer.
> Data stays in BigQuery — it is NOT ingested into the RDF store.
> These findings feed `ontology/economic-census/bigquery-bindings.yaml`.

## Selected Tables

| Table | Dataset | Tier | Reason |
|---|---|---|---|
| `county_2021_1yr` | `census_bureau_acs` | 1 — Primary | 200+ columns, latest 1-year ACS estimates, rich economic + demographic |
| `county_2020_5yr` | `census_bureau_acs` | 1 — Primary | 5-year average — more reliable for small counties (<65k pop) |
| `state_2021_1yr` | `census_bureau_acs` | 1 — Primary | State-level aggregates for high-level reasoning |
| `tract_outcomes` | `census_opportunity_atlas` | 1 — Primary | Raj Chetty's economic mobility outcomes by race/gender/parent income |
| `tract_covariates` | `census_opportunity_atlas` | 1 — Primary | Structural context: poverty share, job density, college share across decades |
| `{year}_q{n}` | `bls_qcew` | 2 — Secondary | Employment + wages by industry sector per county; latest is 2019 Q2 |
| `censustract_2020_5yr` | `census_bureau_acs` | 2 — Secondary | Tract-level ACS; too granular for Phase 1 but useful for future |

## Key Design Decisions

### Why ACS 1-year AND 5-year?
- **1-year** (`county_2021_1yr`): most current, but only covers counties with population ≥65,000 (~820 counties)
- **5-year** (`county_2020_5yr`): covers all 3,200+ counties, statistically more reliable, but data is averaged over 2016–2020
- Use 1-year for populous counties, fall back to 5-year for small ones

### Why Opportunity Atlas?
- Unique dataset: measures **where children end up** based on where they grew up
- Per-tract mobility outcomes broken down by parent income percentile, race, and gender
- No other public dataset captures intergenerational income mobility at this spatial resolution
- Columns encode rich semantic meaning (see `opportunity_atlas.md` for codebook)

### Why BLS QCEW?
- Complements ACS: ACS tells you income/unemployment at the household level, QCEW tells you **industry composition and wages** at the establishment level
- Location quotients (`lq_*`) show whether an industry is over- or under-represented vs. national average — useful for economic specialization queries
- Schema has human-readable column descriptions embedded — directly usable in LLM prompts

### What about unstructured data?
- **BLS QCEW**: every column has a `description` field in the schema — this acts as a machine-readable codebook
- **Opportunity Atlas**: column naming encodes meaning (`kfr_black_female_p25` = family income rank at age 35 for Black females whose parents were at the 25th income percentile) — needs a codebook documented in `opportunity_atlas.md`
- No free-text narrative fields found in any BigQuery census table
- Unstructured content exists in Census Bureau PDFs/briefs — not in BigQuery, worth indexing separately in Phase 2

## Join Keys Across Tables

| Table | Join Column | Format | Example |
|---|---|---|---|
| ACS county/state | `geo_id` | `{summary_level}US{fips}` STRING | `"0500000US36079"` |
| ACS censustract | `geo_id` | `{summary_level}US{state_fips}{county_fips}{tract}` | `"1400000US36079123456"` |
| Opportunity Atlas | `state` + `county` + `tract` | separate INTEGERs | `36`, `79`, `123456` |
| BLS QCEW | `geoid` / `area_fips` | 5-digit FIPS STRING | `"36079"` |

**FIPS is the universal join key.** Extract the 5-digit county FIPS from ACS `geo_id` with:
```sql
SUBSTR(geo_id, -5)   -- for county geo_id like "0500000US36079"
```

For Opportunity Atlas, reconstruct FIPS as:
```sql
LPAD(CAST(state AS STRING), 2, '0') || LPAD(CAST(county AS STRING), 3, '0')
```

## See Also
- [`acs.md`](acs.md) — ACS table schemas and curated column list
- [`opportunity_atlas.md`](opportunity_atlas.md) — Opportunity Atlas codebook and mobility metrics
- [`bls.md`](bls.md) — BLS QCEW schema and industry wage/employment patterns
