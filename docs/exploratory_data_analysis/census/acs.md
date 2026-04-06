# American Community Survey (ACS) — EDA Findings

**Dataset**: `bigquery-public-data.census_bureau_acs`
**Coverage**: US counties, states, census tracts, ZCTAs, PUMAs, congressional districts

## Tables of Interest

| Table | Year | Granularity | Coverage |
|---|---|---|---|
| `county_2021_1yr` | 2021 (latest) | County | ~820 counties (pop ≥65k) |
| `county_2020_5yr` | 2016–2020 avg | County | All 3,200+ counties |
| `state_2021_1yr` | 2021 | State | All 50 states + DC |
| `censustract_2020_5yr` | 2016–2020 avg | Census Tract | ~85,000 tracts |

## Schema Summary — `county_2021_1yr`

Confirmed column count: **200+** — all FLOAT except `geo_id` (STRING).

### Identity
| Column | Type | Description |
|---|---|---|
| `geo_id` | STRING | Full GEOID e.g. `"0500000US36079"`. Strip `"0500000US"` prefix to get 5-digit FIPS. |

### Core Economic Indicators (curated for bindings)
| Column | Type | Description |
|---|---|---|
| `total_pop` | FLOAT | Total population |
| `median_income` | FLOAT | Median household income (inflation-adjusted) |
| `income_per_capita` | FLOAT | Per capita income |
| `poverty` | FLOAT | Population below poverty level (count) |
| `unemployed_pop` | FLOAT | Unemployed population (count) |
| `gini_index` | FLOAT | Gini coefficient of income inequality [0–1]; higher = more unequal |
| `percent_income_spent_on_rent` | FLOAT | Rent burden as % of income |
| `median_rent` | FLOAT | Median gross rent ($) |
| `owner_occupied_housing_units_median_value` | FLOAT | Median home value ($) |

### Demographics
| Column | Type | Description |
|---|---|---|
| `median_age` | FLOAT | Median age |
| `female_pop` | FLOAT | Female population |
| `male_pop` | FLOAT | Male population |
| `white_pop` | FLOAT | White non-Hispanic population |
| `black_pop` | FLOAT | Black/African American population |
| `hispanic_pop` | FLOAT | Hispanic/Latino population |
| `asian_pop` | FLOAT | Asian population |
| `hispanic_any_race` | FLOAT | Hispanic of any race |
| `not_us_citizen_pop` | FLOAT | Non-citizen population |

### Education
| Column | Type | Description |
|---|---|---|
| `bachelors_degree_or_higher_25_64` | FLOAT | Pop 25–64 with bachelor's degree or higher |
| `less_than_high_school_graduate` | FLOAT | Pop 25+ without high school diploma |
| `high_school_including_ged` | FLOAT | Pop 25+ with HS diploma or GED |
| `graduate_professional_degree` | FLOAT | Pop 25+ with graduate/professional degree |

### Employment & Industry
| Column | Type | Description |
|---|---|---|
| `employed_pop` | FLOAT | Employed population |
| `civilian_labor_force` | FLOAT | Civilian labor force |
| `not_in_labor_force` | FLOAT | Population not in labor force |
| `employed_manufacturing` | FLOAT | Workers in manufacturing |
| `employed_education_health_social` | FLOAT | Workers in education/health/social services |
| `employed_finance_insurance_real_estate` | FLOAT | Workers in finance/insurance/real estate |
| `employed_retail_trade` | FLOAT | Workers in retail trade |
| `management_business_sci_arts_employed` | FLOAT | Workers in management/business/science/arts |

### Housing
| Column | Type | Description |
|---|---|---|
| `housing_units` | FLOAT | Total housing units |
| `occupied_housing_units` | FLOAT | Occupied housing units |
| `owner_occupied_housing_units` | FLOAT | Owner-occupied housing units |
| `housing_units_renter_occupied` | FLOAT | Renter-occupied units |
| `vacant_housing_units` | FLOAT | Vacant housing units |

### Income Distribution (brackets)
Columns: `income_less_10000`, `income_10000_14999`, ..., `income_200000_or_more`
— population count in each household income bracket. Useful for computing distribution shape.

### Commuting
| Column | Type | Description |
|---|---|---|
| `aggregate_travel_time_to_work` | FLOAT | Aggregate travel time to work (minutes) |
| `commuters_16_over` | FLOAT | Workers 16 years and over |
| `commuters_by_public_transportation` | FLOAT | Workers using public transit |
| `commuters_drove_alone` | FLOAT | Workers who drove alone |
| `walked_to_work` | FLOAT | Workers who walked |
| `worked_at_home` | FLOAT | Workers who worked from home |

## Sample Values — `county_2021_1yr`

| geo_id | total_pop | median_income | gini_index | poverty | unemployed_pop | rent_burden |
|---|---|---|---|---|---|---|
| 36079 (Rockland, NY) | 97,936 | $106,871 | 0.447 | 7,408 | 2,527 | 34.5% |
| 47065 (Hamilton, TN) | 369,135 | $66,096 | 0.498 | 44,949 | 9,652 | 28.6% |
| 12097 (Osceola, FL) | 403,282 | $60,585 | 0.433 | 54,959 | 13,083 | 39.9% |

## Notes
- All numeric columns are FLOAT even for integer-valued metrics (count of people)
- 1-year estimates for small counties are suppressed (NULL) — use 5-year for full coverage
- `geo_id` prefix varies by geography level: counties use `0500000US`, tracts use `1400000US`
