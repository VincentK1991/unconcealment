# Semantic Binding Layer — Design Decision

> **Status**: Decided — Phase 1 implementation target
> **Decided**: 2026-04-06
> **Scope**: How external relational and structured data sources are semantically bound to the knowledge graph

---

## 1. Problem Statement

The knowledge graph does not ingest structured data (BigQuery tables, SQL databases, REST APIs) into the triplestore. Instead, a **semantic binding layer** describes external sources at the metadata level so that AI consumers can reason across both the graph and external data without a full copy.

The current binding format is a custom YAML file (`ontology/{dataset}/bigquery-bindings.yaml`) that lives outside the graph. It contains table schemas, column semantics, join keys, and LLM query examples — but it is:
- Not queryable via SPARQL
- Not versioned alongside ontology and rules as a graph citizen
- Not expressed in any open standard vocabulary
- Not extensible to non-BigQuery sources without a new format

The goal is to express this binding layer in an open standard vocabulary, store it as RDF triples inside the graph (a named graph citizen like the ontology and rules), and extend it with LLM-facing annotations for query-time AI use.

---

## 2. Assumptions Surfaced

Before deciding on the approach, the following hidden assumptions were made explicit:

| Assumption | Decision |
|---|---|
| "Put binding into RDF store" means the binding metadata becomes a named graph citizen, fully queryable via SPARQL | **Confirmed** |
| The open standard anchor should be R2RML (W3C Recommendation) | **Confirmed** |
| The query-time execution model stays as LLM-generated SQL; the binding enriches metadata, not the runtime path | **Confirmed** |
| Scope beyond BigQuery: other SQL DBs, REST APIs, and flat files (CSV/Parquet) | **Confirmed** |

---

## 3. Open Standard Evaluation

### 3.1 R2RML (W3C Recommendation, 2012)

**Spec**: https://www.w3.org/TR/r2rml/
**Prefix**: `rr: <http://www.w3.org/ns/r2rml#>`

R2RML is the W3C Recommendation for mapping relational data to RDF. It defines a formal, machine-readable mapping vocabulary expressed in Turtle/RDF:

| R2RML Concept | Purpose |
|---|---|
| `rr:TriplesMap` | One mapping unit per logical table/query |
| `rr:logicalTable` | Points to SQL source: `rr:tableName` (direct table) or `rr:sqlQuery` (custom SQL) |
| `rr:subjectMap` | Defines how entity IRIs are generated (`rr:template`, `rr:column`, `rr:constant`) + `rr:class` for rdf:type |
| `rr:predicateObjectMap` | Maps each column to a predicate-object pair |
| `rr:objectMap` | `rr:column`, `rr:template`, `rr:datatype`, `rr:language` |
| `rr:parentTriplesMap` + `rr:joinCondition` | Expresses inter-table joins (child/parent key columns) |

**Why R2RML as the anchor**:
- W3C Recommendation — highest stability guarantee
- Expressed entirely in RDF/Turtle — loads directly into Fuseki with no parser
- Maps naturally to the existing YAML structure (table → entity class → columns → predicates)
- Tooling ecosystem: Ontop, Morph-KGC, RMLMapper can execute R2RML mappings if programmatic execution is ever needed
- Already understood by LLMs — the vocabulary is well-represented in training data

**Limitation**: R2RML is SQL-only. It cannot describe REST API endpoints or flat files.

### 3.2 RML (RDF Mapping Language)

**Spec**: http://semweb.mmlab.be/ns/rml#
**Prefix**: `rml: <http://semweb.mmlab.be/ns/rml#>`

RML extends R2RML for non-SQL sources. It replaces `rr:logicalTable` with `rml:logicalSource`:

```turtle
rml:logicalSource [
    rml:source <#MySource> ;
    rml:referenceFormulation ql:JSONPath ;
    rml:iterator "$.results[*]"
]
```

Reference formulations (`ql:` prefix = `http://semweb.mmlab.be/ns/ql#`):
- `ql:SQL2008` — standard SQL
- `ql:JSONPath` — REST API responses / JSON files
- `ql:CSV` — flat files (CSV, TSV)

RML is not a W3C Recommendation but is the de facto community standard for non-SQL RDF lifting and is backed by active tooling (RMLMapper, Carml, Morph-KGC).

### 3.3 Custom OWL Annotations Only

Defining a bespoke `ex:SqlBinding` class with custom properties. Maximum flexibility but no standard tooling, no interoperability, and it recreates the same problem as the current YAML in a different format.

**Rejected** except as a supplement for LLM-facing metadata not covered by R2RML/RML.

---

## 4. Decision

**Anchor on R2RML + RML extensions + custom LLM annotations.**

- **R2RML** is the primary vocabulary for all SQL sources (BigQuery, PostgreSQL, MySQL, Snowflake, Redshift)
- **RML extensions** (`rml:logicalSource`, `rml:referenceFormulation`) are used for REST API and flat file sources
- **Custom `ex:` annotations** supplement R2RML/RML with LLM-facing metadata that has no standard equivalent: query examples, column descriptions, data quality notes

This combination ensures:
1. The binding is expressed in a W3C-grounded vocabulary
2. Any R2RML/RML processor could execute the mappings programmatically in the future (Phase 3 option)
3. The LLM gets rich semantic hints via standard RDF predicates (`rdfs:comment`, `rdfs:label`) plus custom annotations
4. The format is Turtle — no new parser, loads directly into Fuseki

---

## 5. Named Graph Convention

Bindings are stored in a dedicated named graph per dataset, following the existing `urn:{dataset-id}:{role}` convention:

| Named Graph | Contents |
|---|---|
| `urn:{dataset-id}:bindings` | R2RML/RML TriplesMap definitions + custom LLM annotations |

This graph is part of the **TBox layer** — it describes structure, not instances. It is loaded at startup alongside the ontology and rules.

The manifest.yaml already registers bindings per dataset via `bigquery.bindingsPath`. This key is generalized to `bindingsPath` (dropping the BigQuery-specific name) and now points to a Turtle file instead of YAML:

```yaml
# ontology/manifest.yaml
datasets:
  - id: economic-census
    bindingsPath: ontology/economic-census/bindings.ttl   # was: bigquery-bindings.yaml
```

---

## 6. Binding Vocabulary

### 6.1 Prefixes

```turtle
@prefix rr:   <http://www.w3.org/ns/r2rml#> .
@prefix rml:  <http://semweb.mmlab.be/ns/rml#> .
@prefix ql:   <http://semweb.mmlab.be/ns/ql#> .
@prefix ex:   <https://kg.unconcealment.io/ontology/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
```

### 6.2 SQL Source (R2RML — BigQuery and other SQL DBs)

```turtle
<#AcsCounty1yr>
    a rr:TriplesMap ;
    rdfs:label "ACS County 1-Year Estimates (2021)" ;
    rdfs:comment """American Community Survey 1-year estimates at the county level (2021).
        Covers ~820 US counties with population ≥65,000. Use this for populous counties.
        For smaller counties (<65k pop) use AcsCounty5yr instead.""" ;

    # --- SQL source ---
    rr:logicalTable [
        rr:sqlQuery """
            SELECT SUBSTR(geo_id, -5) AS fips,
                   geo_id, total_pop, median_income, income_per_capita,
                   poverty, unemployed_pop, gini_index,
                   percent_income_spent_on_rent, median_rent
            FROM `bigquery-public-data.census_bureau_acs.county_2021_1yr`
        """
    ] ;

    # --- Entity IRI minting ---
    rr:subjectMap [
        rr:template "https://kg.unconcealment.io/entity/{fips}" ;
        rr:class ex:County
    ] ;

    # --- Property mappings ---
    rr:predicateObjectMap [
        rr:predicate ex:fipsCode ;
        rr:objectMap  [ rr:column "fips" ; rr:datatype xsd:string ]
    ] ;
    rr:predicateObjectMap [
        rr:predicate ex:medianIncome ;
        rr:objectMap  [ rr:column "median_income" ; rr:datatype xsd:decimal ]
    ] ;
    rr:predicateObjectMap [
        rr:predicate ex:giniIndex ;
        rr:objectMap  [ rr:column "gini_index" ; rr:datatype xsd:decimal ]
    ] ;

    # --- LLM annotations (custom, not R2RML) ---
    ex:joinKey        "fips" ;                         # canonical join column after template expression
    ex:joinExpression "SUBSTR(geo_id, -5)" ;           # SQL expression to derive join key
    ex:dataSource     "bigquery-public-data" ;         # GCP project or connection alias
    ex:queryExample   ex:AcsCounty1yr_example_1, ex:AcsCounty1yr_example_2 .

ex:AcsCounty1yr_example_1
    a ex:QueryExample ;
    rdfs:label "Key economic indicators for a county by FIPS" ;
    ex:sql """
        SELECT geo_id, total_pop, median_income, income_per_capita,
               poverty, unemployed_pop, gini_index, percent_income_spent_on_rent
        FROM `bigquery-public-data.census_bureau_acs.county_2021_1yr`
        WHERE SUBSTR(geo_id, -5) = @fips
        LIMIT 1
    """ .
```

### 6.3 REST API Source (RML Extension)

For sources that are not SQL databases, `rr:logicalTable` is replaced with `rml:logicalSource`:

```turtle
<#CensusApiCountyPoverty>
    a rr:TriplesMap ;
    rdfs:label "Census Bureau API — County Poverty Estimates" ;
    rdfs:comment "Small Area Income and Poverty Estimates (SAIPE) from the Census Bureau REST API." ;

    rml:logicalSource [
        rml:source <#CensusApiSource> ;
        rml:referenceFormulation ql:JSONPath ;
        rml:iterator "$..[?(@.state)]"       # JSONPath to iterate over county records
    ] ;

    rr:subjectMap [
        rr:template "https://kg.unconcealment.io/entity/{state}{county}" ;
        rr:class ex:County
    ] ;

    rr:predicateObjectMap [
        rr:predicate ex:fipsCode ;
        rr:objectMap [ rml:reference "state" ]     # rml:reference instead of rr:column for non-SQL
    ] ;

    ex:dataSource     "https://api.census.gov/data/timeseries/poverty/saipe" ;
    ex:queryExample   ex:CensusApi_example_1 .

<#CensusApiSource>
    a ex:RestApiSource ;
    ex:baseUrl    "https://api.census.gov/data/timeseries/poverty/saipe" ;
    ex:authScheme "none" ;                          # none | apiKey | oauth2
    ex:parameterDoc """Required params: get=SAEPOVALL_PT,SAEPOVPTALL,NAME&for=county:*&in=state:*&YEAR=2021""" .
```

### 6.4 Flat File Source (RML Extension)

```turtle
<#CountyShapefileMap>
    a rr:TriplesMap ;
    rdfs:label "County FIPS Crosswalk (CSV)" ;

    rml:logicalSource [
        rml:source      "gs://unconcealment-data/crosswalks/county_fips_2020.csv" ;
        rml:referenceFormulation ql:CSV
    ] ;

    rr:subjectMap [
        rr:template "https://kg.unconcealment.io/entity/{FIPS}" ;
        rr:class ex:County
    ] .
```

### 6.5 Custom LLM Annotation Vocabulary

These properties supplement R2RML/RML with information that has no standard equivalent. Defined in the ontology TBox (`core.ttl`):

```turtle
# In core.ttl — custom binding annotation vocabulary

ex:QueryExample
    a owl:Class ;
    rdfs:label "Query Example" ;
    rdfs:comment "A worked SQL or API query example attached to a TriplesMap for LLM guidance." .

ex:RestApiSource
    a owl:Class ;
    rdfs:label "REST API Source" ;
    rdfs:comment "Describes a REST API endpoint used as an rml:source." .

ex:queryExample
    a owl:ObjectProperty ;
    rdfs:domain rr:TriplesMap ;
    rdfs:range  ex:QueryExample ;
    rdfs:label "query example" .

ex:sql
    a owl:DatatypeProperty ;
    rdfs:domain ex:QueryExample ;
    rdfs:range  xsd:string ;
    rdfs:label "SQL or API query string" .

ex:joinKey
    a owl:DatatypeProperty ;
    rdfs:domain rr:TriplesMap ;
    rdfs:range  xsd:string ;
    rdfs:label "join key column name after template expression" .

ex:joinExpression
    a owl:DatatypeProperty ;
    rdfs:domain rr:TriplesMap ;
    rdfs:range  xsd:string ;
    rdfs:label "SQL expression to derive the join key from raw column(s)" .

ex:dataSource
    a owl:DatatypeProperty ;
    rdfs:domain rr:TriplesMap ;
    rdfs:range  xsd:string ;
    rdfs:label "GCP project, JDBC connection alias, or base URL identifying the data source" .

ex:parameterDoc
    a owl:DatatypeProperty ;
    rdfs:domain ex:RestApiSource ;
    rdfs:range  xsd:string ;
    rdfs:label "Human-readable documentation of required/optional API parameters" .

ex:authScheme
    a owl:DatatypeProperty ;
    rdfs:domain ex:RestApiSource ;
    rdfs:range  xsd:string ;
    rdfs:label "Authentication scheme: none | apiKey | oauth2 | basic" .
```

---

## 7. How the LLM Reads Binding Metadata

At query time, the LLM (via MCP tool or CLI) reads binding metadata by issuing a SPARQL query against the bindings named graph. The Java backend exposes this via `POST /query/tbox` (raw, no inference needed for bindings):

```sparql
PREFIX rr:   <http://www.w3.org/ns/r2rml#>
PREFIX rml:  <http://semweb.mmlab.be/ns/rml#>
PREFIX ex:   <https://kg.unconcealment.io/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?map ?label ?description ?dataSource ?sql ?joinKey ?joinExpr
       ?exampleLabel ?exampleSql
FROM <urn:economic-census:bindings>
WHERE {
    ?map a rr:TriplesMap ;
         rdfs:label ?label .

    OPTIONAL { ?map rdfs:comment ?description }
    OPTIONAL { ?map ex:dataSource ?dataSource }
    OPTIONAL { ?map ex:joinKey ?joinKey }
    OPTIONAL { ?map ex:joinExpression ?joinExpr }

    # SQL source
    OPTIONAL {
        ?map rr:logicalTable ?lt .
        OPTIONAL { ?lt rr:sqlQuery ?sql }
        OPTIONAL { ?lt rr:tableName ?sql }
    }

    # Query examples
    OPTIONAL {
        ?map ex:queryExample ?ex .
        ?ex rdfs:label ?exampleLabel ;
            ex:sql ?exampleSql .
    }
}
ORDER BY ?map ?exampleLabel
```

The LLM assembles this result into context before generating SQL — replacing the current approach of parsing YAML files at tool invocation time.

---

## 8. Mapping YAML → Turtle

The existing `bigquery-bindings.yaml` structure maps to R2RML + custom annotations as follows:

| YAML field | R2RML / Custom equivalent |
|---|---|
| `id` | Named blank node or local IRI fragment `<#TableId>` |
| `dataset` + `table` | `rr:logicalTable [ rr:sqlQuery "SELECT ... FROM \`project.dataset.table\`" ]` |
| `description` | `rdfs:comment` on the `rr:TriplesMap` |
| `rdfBinding.entityClass` | `rr:subjectMap [ rr:class <entityClass> ]` |
| `rdfBinding.joinProperty` | `rr:predicateObjectMap [ rr:predicate <joinProperty> ]` |
| `rdfBinding.joinExpression` | `ex:joinExpression` (custom annotation) |
| `keyColumns[].name` | `rr:predicateObjectMap [ rr:objectMap [ rr:column "name" ] ]` |
| `keyColumns[].description` | `rdfs:comment` on a column-level blank node, or `rdfs:comment` on the `rr:ObjectMap` |
| `queryExamples[].intent` | `rdfs:label` on an `ex:QueryExample` instance |
| `queryExamples[].sql` | `ex:sql` on the `ex:QueryExample` instance |

Column-level descriptions (not natively supported in R2RML) are attached via `rdfs:comment` on the `rr:ObjectMap` blank node. This is a valid RDF extension — R2RML does not prohibit additional triples on its blank nodes.

---

## 9. Non-Goals

The following are explicitly out of scope for this design:

- **SPARQL-to-SQL translation**: No Ontop or OBDA-style execution. The LLM generates SQL; there is no programmatic query rewriting. This remains an option for Phase 3 if needed.
- **Full R2RML execution**: The R2RML maps are read as metadata by the LLM, not executed by an R2RML processor to materialize triples. Programmatic execution is a future upgrade path, not a current requirement.
- **SPARQL `SERVICE` federation**: Also a Phase 3 option per the project roadmap.
- **BigQuery schema validation**: Deferred to Phase 2 per project decisions.
- **SHACL validation of binding files**: Deferred to Phase 2.

---

## 10. Integration Points

### 10.1 manifest.yaml

The `bigquery.bindingsPath` key in `ontology/manifest.yaml` is renamed to `bindingsPath` (source-agnostic) and now points to a Turtle file. The Java backend loads it into `urn:{dataset-id}:bindings` at startup, the same way it loads ontology and rules files.

```yaml
# Before
bigquery:
  enabled: true
  bindingsPath: ontology/economic-census/bigquery-bindings.yaml

# After
bindingsPath: ontology/economic-census/bindings.ttl
```

### 10.2 Named Graph Lifecycle

`urn:{dataset-id}:bindings` follows TBox lifecycle rules:
- Loaded at startup and on `POST /admin/reload`
- Can be wiped and reloaded without affecting ABox data
- Versioned in Git alongside the Turtle ontology files
- Queryable via `POST /query/tbox` (bypasses InfModel — no inference needed on binding metadata)

### 10.3 Ontology (core.ttl)

The custom annotation vocabulary (`ex:QueryExample`, `ex:RestApiSource`, `ex:queryExample`, `ex:sql`, etc.) is added to each dataset's `core.ttl` or to a shared base ontology. These additions are additive and do not affect existing classes or properties.

---

## 11. Open Questions for Phase 2

1. **Column-level semantic typing**: Should individual columns carry `rdfs:range` via the R2RML `rr:datatype`, or should a custom `ex:semanticType` link to an ontology class (e.g., `ex:GiniCoefficient`)? The latter enables richer reasoning but increases maintenance overhead.

2. **Cross-dataset join documentation**: The current YAML documents cross-table joins in query examples. Should inter-dataset joins (e.g., ACS ↔ QCEW via FIPS) be modeled as R2RML `rr:parentTriplesMap` + `rr:joinCondition`, or remain as ad-hoc query examples?

3. **REST API authentication**: For REST sources that require API keys, where are credentials injected? Environment variables resolved at query time, or a separate `ex:credentialRef` pointer to a secret manager key?

4. **Binding validation**: SHACL shapes to enforce that every `rr:TriplesMap` has at minimum `rdfs:label`, `rdfs:comment`, `ex:dataSource`, and at least one `ex:queryExample`. Deferred to Phase 2 per project decision.

5. **Binding versioning**: When a BigQuery table schema changes (e.g., a column renamed), how is the binding update propagated? Additive-first ontology evolution principles suggest adding the new column mapping and deprecating the old predicate rather than renaming in place.
