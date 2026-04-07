# Ontology Findings: Census Unstructured Documents

**Date**: 2026-04-06  
**Scope**: Entity extraction from `data/economic-census/` PDFs for knowledge graph ingestion  
**Target entities**: Demographics + Economic indicators  
**Granularity**: Summary statistics (top-level figures)

---

## 1. Document Corpus Overview

Sampled 6 document types from 30+ PDFs in `data/economic-census/`:

| Series | Example | Content type |
|--------|---------|-------------|
| `c2020br-XX` | Congressional Apportionment | Decennial census briefs — population counts, state apportionment, historical trends |
| `acsbr-XX` | Poverty in States and MSAs: 2023 | ACS 1-year briefs — poverty rates, income, demographics by state/MSA |
| `p60-XXX` | Health Insurance Coverage: 2023–2024 | CPS ASEC reports — income, poverty, insurance coverage |
| `p25-XXXX` | Population Projections 2020–2060 | Population projections — age, race, immigration drivers |
| `p70-XXX` | Child Well-Being SIPP 2023 | SIPP reports — household characteristics, parental engagement |
| `ft895-XX` | US Trade with Puerto Rico/Possessions | Foreign trade — commodity shipments by schedule B code and transport method |

### Common structural patterns across documents
- **Narrative summary** (1–3 pages) with highlight bullets and key statistics
- **Data tables** (usually suppressed columns in plain-text parse — liteparse drops table values for scanned PDFs)
- **Footnotes/methodology boxes** explaining survey definitions and confidence levels
- **Geographic scope**: nation → state → MSA/county hierarchy
- **Temporal scope**: single reference year or year-over-year comparison

---

## 2. Recommended Ontology Stack

Given the use case (knowledge graph via `assertToGraph`, formal linked data, summary statistics only), the recommended ontology stack is:

### Primary: RDF Data Cube (QB) — W3C
**Namespace**: `http://purl.org/linked-data/cube#`

This is the best fit. Census data is fundamentally tabular statistical data. QB is explicitly designed for multi-dimensional statistical datasets and is used by Eurostat, ONS, and US federal agencies.

Core QB constructs to use:

| QB construct | Maps to census concept |
|---|---|
| `qb:DataSet` | A specific survey+year combination (e.g., "ACS 2023 1-Year Estimates") |
| `qb:Observation` | A single statistical claim (e.g., poverty rate = 12.5% for US in 2023) |
| `qb:DimensionProperty` | The axes: geography, time, demographic group |
| `qb:MeasureProperty` | The measured value: povertyRate, medianHouseholdIncome, populationCount |
| `qb:AttributeProperty` | Metadata: margin of error, confidence level, suppression flag |

### Supporting: Schema.org
**Namespace**: `https://schema.org/`

For document provenance and top-level entities:
- `schema:Dataset` — the census report as a citable artifact
- `schema:GovernmentOrganization` — U.S. Census Bureau
- `schema:Place` — geographic areas with `schema:identifier` holding FIPS code
- `schema:StatisticalPopulation` — a described subgroup (e.g., "women 65+ below poverty line")

### Supporting: PROV-O — W3C Provenance
**Namespace**: `http://www.w3.org/ns/prov#`

Tracks lineage from raw document to extracted assertion:
- `prov:Entity` — the observation
- `prov:wasDerivedFrom` — links observation → report PDF
- `prov:wasGeneratedBy` — links observation → survey activity (ACS 2023 data collection)

### Supporting: SDMX Concept Schemes
**Namespace**: `http://purl.org/linked-data/sdmx/2009/concept#`

Census Bureau uses SDMX-aligned concepts for official statistics. Provides ready-made codelists for:
- Sex (`sdmx-code:sex-M`, `sdmx-code:sex-F`)
- Age groups
- Geographic levels

---

## 3. Entity Type Model

This is the ontology to give the LLM for entity extraction. Designed to be JSON-serializable and map cleanly to the graph's node/edge model.

### Entity Types

#### `GeographicArea`
```
Properties:
  - fipsCode: string          # e.g. "06" for California, "06037" for LA County
  - name: string              # human-readable
  - level: enum [nation | state | county | msa | congressional_district | census_tract]
  - parentFips: string?       # FIPS of containing area
```
*Maps to*: `schema:Place` + `qb:DimensionProperty` (geo)

#### `PopulationGroup`
```
Properties:
  - characteristicType: enum [age | sex | race | ethnicity | nativity | poverty_status | insurance_status | household_type]
  - characteristicValue: string   # e.g. "65 and over", "Hispanic or Latino", "Below poverty threshold"
  - ombCode: string?              # OMB race/ethnicity classification code where applicable
```
*Maps to*: `schema:StatisticalPopulation`

#### `CensusSurvey`
```
Properties:
  - surveyName: string        # "American Community Survey", "Current Population Survey ASEC", "SIPP", "Decennial Census"
  - vintage: integer          # reference year (e.g. 2023)
  - methodology: string?      # "1-year estimates", "5-year estimates", "cohort-component"
  - seriesCode: string?       # "ACS", "CPS", "SIPP", "P25", "P60", "P70"
```
*Maps to*: `qb:DataSet` + `prov:Activity`

#### `StatisticalMeasure`
```
Properties:
  - measureName: string       # e.g. "povertyRate", "medianHouseholdIncome", "populationCount", "healthInsuranceCoverageRate"
  - unit: string              # "percent", "dollars", "persons", "seats"
  - measureType: enum [rate | count | median | mean | ratio | projection]
  - sdmxConcept: string?      # SDMX concept URI if mappable
```
*Maps to*: `qb:MeasureProperty`

#### `StatisticalObservation`
```
Properties:
  - value: number
  - marginOfError: number?
  - confidenceLevel: string?  # "90 percent"
  - referenceYear: integer
  - changeFromPriorYear: number?
  - changeDirection: enum [increase | decrease | no_significant_change]?

Relationships:
  - refersToGeography: GeographicArea
  - refersToGroup: PopulationGroup?    # null = total population
  - measures: StatisticalMeasure
  - derivedFrom: CensusSurvey
  - sourcedFrom: ReportDocument
```
*Maps to*: `qb:Observation`

#### `ReportDocument`
```
Properties:
  - seriesCode: string        # "c2020br-01", "acsbr-022", "p60-284"
  - title: string
  - publicationDate: string   # ISO date
  - authors: string[]
  - surveySource: CensusSurvey
```
*Maps to*: `schema:Dataset` + `prov:Entity`

### Key Relationships

```
GeographicArea  --spatiallyContains-->  GeographicArea
StatisticalObservation  --refersToGeography-->  GeographicArea
StatisticalObservation  --refersToGroup-->  PopulationGroup
StatisticalObservation  --measures-->  StatisticalMeasure
StatisticalObservation  --derivedFrom-->  CensusSurvey
StatisticalObservation  --sourcedFrom-->  ReportDocument
ReportDocument  --publishedBy-->  schema:GovernmentOrganization
```

---

## 4. Key Measure Vocabulary

Priority measures to extract, with recommended `measureName` values:

### Demographics
| measureName | Unit | Example source |
|---|---|---|
| `totalPopulation` | persons | c2020br, p25 |
| `populationGrowthRate` | percent | p25, c2020br |
| `medianAge` | years | p25 |
| `raceCompositionShare` | percent | c2020br, acsbr |
| `congressionalSeats` | seats | c2020br |
| `apportionmentPopulation` | persons | c2020br |
| `projectedPopulation` | persons | p25 |
| `naturalIncrease` | persons | p25 |
| `netInternationalMigration` | persons | p25 |

### Economic Indicators
| measureName | Unit | Example source |
|---|---|---|
| `povertyRate` | percent | acsbr, p60 |
| `populationBelowPoverty` | persons | acsbr |
| `incomeToPovertyRatio` | ratio | acsbr |
| `medianHouseholdIncome` | dollars | p60 |
| `healthInsuranceCoverageRate` | percent | p60-284, p60-288 |
| `uninsuredRate` | percent | p60-284, p60-288 |
| `tradeShipmentValue` | dollars | ft895 |

---

## 5. Document-Type-Specific Extraction Notes

### Decennial Census Briefs (`c2020br-*`)
- Primary geography: state-level
- Key entities: `GeographicArea` (states), `StatisticalObservation` (apportionment population, seat counts)
- Watch for: historical comparison tables (1920–2020), regional trend narratives

### ACS Briefs (`acsbr-*`)
- Primary geography: state + MSA
- Key entities: year-over-year `StatisticalObservation` pairs with `changeDirection`
- Watch for: statistical significance flags ("not significantly changed") — capture as `changeDirection: no_significant_change`

### CPS ASEC Reports (`p60-*`)
- Primary geography: national, then state
- Key entities: health insurance and income measures broken out by `PopulationGroup` (age, race, employment status)
- Watch for: multiple coverage types (private vs. public insurance) — use `measureName` to disambiguate

### Population Projections (`p25-*`)
- Temporal dimension: projection years, not historical
- Key entities: `projectedPopulation`, `naturalIncrease`, `netInternationalMigration` by future year
- Watch for: projection series vintage (2017 series vs. 2023 series) — capture in `CensusSurvey.methodology`

### Foreign Trade (`ft895-*`)
- Different entity model — not demographics/economics
- Entities: commodity (Schedule B code), origin/destination territory, transport method, shipment value
- **Recommendation**: treat as out-of-scope for the demographics+economics KG; index separately if needed

---

## 6. Parsing Considerations

- **liteparse with `--no-ocr`** works well for the narrative sections (good text extraction)
- **Tables are problematic**: column values are often dropped or garbled in plain-text output — the table structure collapses. Use `--format json` + bounding boxes for table-heavy pages, or restrict extraction to narrative highlights and bullet points (aligns with "summary statistics only" granularity)
- **Margin of error**: frequently stated inline ("12.5 percent... a statistically significant decrease from 12.6 percent") — LLM needs prompt instruction to extract MOE from prose
- **Suppression markers**: `X` in tables means data not applicable; `N/A` or `-` means suppressed — do not create observations for these

---

## 7. Ontology URIs for Implementation

```
@prefix qb:    <http://purl.org/linked-data/cube#> .
@prefix sdmx-concept: <http://purl.org/linked-data/sdmx/2009/concept#> .
@prefix sdmx-code:    <http://purl.org/linked-data/sdmx/2009/code#> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix schema: <https://schema.org/> .
@prefix dcterms: <http://purl.org/dc/terms/> .

# Project-local namespace for census-specific extensions
@prefix census: <https://unconcealment.io/ontology/census#> .
```

`census:` should extend QB for any measure not covered by SDMX, e.g.:
- `census:ApportionmentPopulation`
- `census:IncomeToPovertyRatio`
- `census:ScheduleBCommodityCode`
