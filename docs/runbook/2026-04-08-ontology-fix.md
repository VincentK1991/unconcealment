# Ontology Fix Plan
> **Created**: 2026-04-08
> **Status**: In progress — namespace consistency, richer curated ontology guidance, and TBox/rule separation implemented
> **Scope**: Ontology-guided extraction improvements, open-world vocabulary handling, soft validation, namespace consistency, and keeping rule graphs out of extraction-facing ontology context
> **Code changes in this document**: None. This runbook tracks planned and completed work.

---

## 1. Goal

Improve the indexing pipeline so extraction is strongly guided by the ontology without becoming closed-world or ingestion-blocking.

The target operating model is:

- strict on transport shape
- soft on semantic validation
- open on vocabulary
- explicit about curated terms vs candidate terms
- consistent on ontology namespace policy

This plan also standardizes the ontology namespace to:

```text
http://localhost:4321/ontology/
```

---

## 2. Locked Decisions

These decisions are fixed for this workstream.

1. Unknown extracted terms are written to a separate named graph.
2. Unknown terms are not auto-repaired or rewritten. Emit warnings only.
3. The ontology namespace policy is standardized to `http://localhost:4321/ontology/`.

---

## 2.1 Implementation Status

### Completed in this pass

- Namespace consistency was implemented across source/runtime files.
- Richer curated ontology guidance was implemented for extraction.
- `/query/tbox` now reads only `urn:{datasetId}:tbox:ontology`.
- Extraction-facing ontology queries no longer inject `urn:{datasetId}:tbox:rules:forward` or `urn:{datasetId}:tbox:rules:backward`.
- Rule schema declarations were removed from `ontology/economic-census/core.ttl`.
- `ontology/public-health/core.ttl` required no direct rule-schema changes because it did not declare `Rule`, `ForwardRule`, `BackwardRule`, or rule metadata properties.
- The extractor now pulls:
  - class vs property kind
  - object vs datatype property kind
  - domain
  - range
  - label/comment when present
- The extraction prompt now:
  - explicitly treats ontology as strong guidance rather than a hard restriction
  - explains object-vs-datatype property usage
  - encourages compositional modeling
  - uses an ontology-native illustrative example instead of the old generic company/person example

### Validation results for this pass

- `services/indexing`: `npm run typecheck` passed
- `services/web`: `npm run build` passed
- `services/backend`: `mvn -q -DskipTests compile` passed
- `services/web`: `npm run typecheck` could not run because `astro check` requires `@astrojs/check`, which is not installed in the current workspace

### Remaining after this pass

- candidate vocabulary named graph plumbing
- warning-only soft semantic validation
- candidate term persistence
- ontology-aware same-document merge
- candidate vocabulary prompt context
- broader documentation namespace cleanup outside the files changed in this pass

---

## 3. Problem Statement

The current system already has the right high-level philosophy:

- the graph is open-world
- ontology is documentation and guidance, not phase-1 enforcement
- extraction quality should be guided by ontology

However, the current implementation is still weak in four places:

1. The extractor receives a flat ontology term list, not a usable semantic frame.
2. There is no soft semantic validation layer between extraction and assertion.
3. Unknown vocabulary is preserved at assertion time, but not tracked as a first-class candidate vocabulary stream.
4. Namespace usage is inconsistent across ontology TTL, rules, bindings, backend constants, indexing helpers, and web queries.

The result is that the system is technically open-world at ingest time, but operationally under-guided during extraction and under-instrumented when new vocabulary appears.

---

## 4. Target State

### 4.1 Curated ontology stays authoritative

Curated ontology remains in:

```text
urn:{datasetId}:tbox:ontology
```

This graph is still the source of truth for:

- stable classes
- stable properties
- domains and ranges
- curated semantic documentation

Reasoning rules remain separate and continue to live in:

```text
urn:{datasetId}:tbox:rules:forward
urn:{datasetId}:tbox:rules:backward
```

Those rule graphs should not be injected into extraction-facing ontology context.

### 4.2 Candidate vocabulary becomes a graph citizen

Add a new named graph:

```text
urn:{datasetId}:tbox:candidates
```

This graph stores unknown extracted classes and properties as observed candidates, with provenance and warning metadata.

This graph is not authoritative ontology.

It is:

- a review queue
- an evidence log of vocabulary pressure from documents
- a future source of ontology evolution

### 4.3 Validation becomes warning-only

Validation is split into two layers:

1. **Hard validation**
   - JSON shape
   - relationship index validity
   - required fields for transport
   - these may still fail the activity

2. **Soft validation**
   - known vs unknown class/property
   - near-match warnings
   - domain/range plausibility
   - literal-vs-object plausibility
   - frame completeness
   - these never fail ingestion

### 4.4 Extraction uses ontology as semantic frames

The extractor should not only see:

- class labels
- property labels
- comments

It should also see:

- domain/range
- datatype-vs-object property kind
- preferred class frames
- class-specific identity keys
- aliases and alternative labels
- candidate vocabulary separately labeled as non-curated

### 4.5 Merge becomes ontology-aware

Within a single document run, extracted entities should be merged before assertion when the ontology already gives a strong identity key.

This reduces needless duplicates before `owl:sameAs` normalization even starts.

---

## 5. Current Gaps

### 5.1 Extraction context is too shallow

Current query path:

- `services/indexing/src/constants/pipeline.ts`
- `services/indexing/src/activities/extractEntities.ts`

Current ontology context only fetches:

- `owl:Class`
- `owl:ObjectProperty`
- `owl:DatatypeProperty`
- `rdfs:label`
- `rdfs:comment`

That is not enough for high-quality ontology-guided extraction.

### 5.2 Prompt still implies a too-closed vocabulary posture

The current extractor prompt says to use ontology local names but does not explicitly separate:

- curated ontology terms
- acceptable novel terms
- warning-only semantic mismatches

The prompt should say that novel terms are allowed when no curated term fits.

### 5.3 Assertion is open-world, but candidate vocabulary is invisible

`IngestController` already preserves unknown terms by minting fallback ontology IRIs instead of rejecting them.

That is good, but it is insufficient because:

- unknowns are not reviewable in a dedicated graph
- repeated novel terms are not accumulated
- near-match pressure is not visible to ontology maintainers

### 5.4 Namespace usage is inconsistent

Current namespace usage is split between:

- `https://kg.unconcealment.io/ontology/`
- `http://localhost:4321/ontology/`

This affects:

- ontology TTL
- rule TTL
- BigQuery binding YAML
- backend constants
- indexing constants
- reasoning helpers
- web queries
- runbook examples

This must be made consistent before any open-world vocabulary strategy can be trusted.

### 5.5 Same-document merge is too naive

Current workflow flattens chunk outputs and re-offsets relationship indices, but does not merge semantically identical entities before assertion.

This causes avoidable duplicates for:

- `ReportDocument`
- `CensusSurvey`
- `StatisticalMeasure`
- `PopulationGroup`
- `GeographicArea`

### 5.6 Rule graphs were leaking into extraction-facing ontology queries

The original `/query/tbox` route injected:

- `urn:{datasetId}:tbox:ontology`
- `urn:{datasetId}:tbox:rules:forward`
- `urn:{datasetId}:tbox:rules:backward`

That made extraction-facing ontology queries vulnerable to rule vocabulary contamination.

The route is now narrowed to the ontology graph only, which is the correct contract for ontology browsing and extraction guidance.

---

## 6. New Named Graph

Add:

```text
urn:{datasetId}:tbox:candidates
```

### Purpose

Stores unknown extracted ontology terms and warning metadata.

### Semantics

- candidate terms are not curated ontology
- candidate terms are not loaded from version-controlled TTL at startup
- candidate terms are written at runtime by the indexing pipeline
- candidate terms may later be promoted into curated ontology by human review

### Where named graph support must be added

- `services/backend/src/main/java/com/unconcealment/backend/model/DatasetManifest.java`
- `services/indexing/src/config/manifest.ts`

### Proposed additions

```java
public String tboxCandidates() { return "urn:" + datasetId + ":tbox:candidates"; }
```

```ts
tboxCandidates: `urn:${datasetId}:tbox:candidates`,
```

---

## 7. Candidate Vocabulary Model

Candidate vocabulary needs a minimal RDF model so it is queryable and reviewable.

### Recommended vocabulary

Use the local ontology namespace rather than inventing another one:

```turtle
@prefix ex:   <http://localhost:4321/ontology/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

ex:CandidateTerm
    a owl:Class ;
    rdfs:label "Candidate Term" .

ex:candidateKind
    a owl:DatatypeProperty ;
    rdfs:label "candidate kind" .

ex:proposedLocalName
    a owl:DatatypeProperty ;
    rdfs:label "proposed local name" .

ex:status
    a owl:DatatypeProperty ;
    rdfs:label "status" .

ex:suggestedCuratedMatch
    a owl:ObjectProperty ;
    rdfs:label "suggested curated match" .

ex:warningCode
    a owl:DatatypeProperty ;
    rdfs:label "warning code" .

ex:firstSeenAt
    a owl:DatatypeProperty ;
    rdfs:label "first seen at" .

ex:lastSeenAt
    a owl:DatatypeProperty ;
    rdfs:label "last seen at" .

ex:occurrenceCount
    a owl:DatatypeProperty ;
    rdfs:label "occurrence count" .

ex:seenInRun
    a owl:DatatypeProperty ;
    rdfs:label "seen in run" .

ex:seenInDocument
    a owl:ObjectProperty ;
    rdfs:label "seen in document" .

ex:exampleUsage
    a owl:DatatypeProperty ;
    rdfs:label "example usage" .
```

### Candidate term identity

Candidate term IRIs should be deterministic and dataset-scoped.

Recommended pattern:

```text
http://localhost:4321/ontology/candidate/{datasetId}/{kind}/{sanitizedLocalName}
```

Example:

```text
http://localhost:4321/ontology/candidate/economic-census/property/povertyThresholdCategory
```

### Example candidate graph insert

```sparql
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>

INSERT DATA {
  GRAPH <urn:economic-census:tbox:candidates> {
    <http://localhost:4321/ontology/candidate/economic-census/property/povertyThresholdCategory>
      a ex:CandidateTerm ;
      ex:candidateKind "property" ;
      ex:proposedLocalName "povertyThresholdCategory" ;
      rdfs:label "poverty threshold category" ;
      ex:status "observed" ;
      ex:warningCode "UNKNOWN_PROPERTY" ;
      ex:seenInRun "wf-123:run-456" ;
      ex:seenInDocument <http://localhost:4321/document/economic-census/my-doc> ;
      ex:exampleUsage "Population group has poverty threshold category 'below poverty threshold'" ;
      ex:firstSeenAt "2026-04-08T12:00:00Z"^^xsd:dateTime ;
      ex:lastSeenAt "2026-04-08T12:00:00Z"^^xsd:dateTime ;
      ex:occurrenceCount 1 .
  }
}
```

---

## 8. Soft Validation Model

### Principle

Soft validation must never:

- rewrite the extraction output
- reject the document
- silently coerce novel terms into curated terms

Soft validation may:

- produce warnings
- produce candidate-term records
- produce suggested curated matches
- produce telemetry for ontology review

### Warning codes

Recommended first set:

- `UNKNOWN_CLASS`
- `UNKNOWN_PROPERTY`
- `CLOSE_MATCH_CLASS`
- `CLOSE_MATCH_PROPERTY`
- `DOMAIN_MISMATCH`
- `RANGE_MISMATCH`
- `LITERAL_OBJECT_MISMATCH`
- `FRAME_INCOMPLETE`

### Suggested TypeScript shape

```ts
export interface ExtractionWarning {
  code: string;
  severity: "info" | "warn";
  message: string;
  entityIndex?: number;
  relationshipIndex?: number;
  termLocalName?: string;
  suggestedCuratedMatch?: string;
}

export interface CandidateTermRecord {
  kind: "class" | "property";
  proposedLocalName: string;
  label?: string;
  suggestedCuratedMatch?: string;
  warningCode: string;
  exampleUsage?: string;
}

export interface SoftValidationOutput {
  entities: ExtractionEntity[];
  relationships: ExtractionRelationship[];
  warnings: ExtractionWarning[];
  candidateTerms: CandidateTermRecord[];
}
```

### Where this should run

Add a new activity:

```text
services/indexing/src/activities/softValidateExtraction.ts
```

This activity should run:

1. after chunk results are flattened
2. before `assertToGraph`
3. before normalization

### Workflow position

Target sequence:

```text
resolveDocumentContent
  -> embedAndStore
  -> extractEntitiesFromChunk (fan-out)
  -> mergeExtractionBatch
  -> softValidateExtraction
  -> persistCandidateTerms
  -> assertToGraph
  -> normalizeEntitiesRuleBased
  -> normalizeEntitiesLlm
```

---

## 9. Richer Ontology Guidance for Extraction

### Principle

The extractor should be ontology-guided by semantic frames, not just term lists.

### What the extractor should receive

For curated ontology:

- local name
- label
- comment
- class or property kind
- object vs datatype property
- domain
- range
- aliases if present
- example frame if present

For candidate vocabulary:

- candidate local name
- label if known
- candidate kind
- occurrence count
- status

The two sets must be presented separately in the prompt so the model understands:

- curated ontology is preferred
- candidate vocabulary is available as precedent, not authority
- novel terms are still allowed when neither fits

### Where to change

- `services/indexing/src/constants/pipeline.ts`
- `services/indexing/src/activities/extractEntities.ts`
- new helper recommended:
  - `services/indexing/src/lib/fetchOntologyGuidance.ts`
  - or `services/indexing/src/activities/fetchOntologyGuidance.ts`

### Replace the current flat ontology query

Current query only returns labels and comments. Replace it with a richer query such as:

```sparql
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?term ?kind ?label ?comment ?domain ?range ?propertyKind WHERE {
  GRAPH <urn:{datasetId}:tbox:ontology> {
    {
      ?term a owl:Class .
      BIND("class" AS ?kind)
    }
    UNION
    {
      ?term a ?ptype .
      FILTER(?ptype IN (owl:ObjectProperty, owl:DatatypeProperty))
      BIND("property" AS ?kind)
      BIND(IF(?ptype = owl:ObjectProperty, "object", "datatype") AS ?propertyKind)
      OPTIONAL { ?term rdfs:domain ?domain }
      OPTIONAL { ?term rdfs:range ?range }
    }
    OPTIONAL { ?term rdfs:label ?label }
    OPTIONAL { ?term rdfs:comment ?comment }
  }
}
ORDER BY ?kind ?label
```

### Candidate graph query

```sparql
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?term ?kind ?label ?status ?count WHERE {
  GRAPH <urn:{datasetId}:tbox:candidates> {
    ?term a ex:CandidateTerm ;
          ex:candidateKind ?kind ;
          ex:status ?status ;
          ex:occurrenceCount ?count .
    OPTIONAL { ?term rdfs:label ?label }
  }
}
ORDER BY DESC(?count) ?label
LIMIT 200
```

### Prompt guidance to add

```text
Use curated ontology terms whenever they fit the text.

Do not force a curated term when it is semantically wrong.

If no curated term fits, you may emit a novel class or property local name.
Novel terms are allowed and will be recorded as candidate vocabulary.

Candidate vocabulary listed below is not curated ontology. It is prior observed vocabulary only.

Semantic mismatches do not block ingestion, but you should still prefer the most semantically accurate term.
```

### Prompt example fix

The current example in `pipeline.ts` uses terms like `Person`, `foundingYear`, `headquarteredIn`, and `isLeaderOf`, which do not represent the census extraction frame.

Replace it with a domain-native example using:

- `StatisticalObservation`
- `StatisticalMeasure`
- `GeographicArea` or `County`
- `CensusSurvey`
- `ReportDocument`

Example:

```json
{
  "entities": [
    {
      "label": "2023 poverty rate in California",
      "type": "StatisticalObservation",
      "description": "A statistical observation reporting California's poverty rate for 2023.",
      "attributes": [
        { "predicate": "observationValue", "value": "12.5" },
        { "predicate": "referenceYear", "value": "2023" }
      ]
    },
    {
      "label": "California",
      "type": "State",
      "description": "A U.S. state.",
      "attributes": [
        { "predicate": "fipsCode", "value": "06" }
      ]
    },
    {
      "label": "povertyRate",
      "type": "StatisticalMeasure",
      "description": "A named statistical measure representing the poverty rate.",
      "attributes": [
        { "predicate": "measureName", "value": "povertyRate" },
        { "predicate": "measureUnit", "value": "percent" },
        { "predicate": "measureType", "value": "rate" }
      ]
    }
  ],
  "relationships": [
    { "subjectId": 0, "predicate": "refersToGeography", "objectId": 1, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.95 },
    { "subjectId": 0, "predicate": "measures", "objectId": 2, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.95 }
  ]
}
```

---

## 10. Ontology-Aware Merge Before Assertion

### Principle

If the ontology already gives a stable identity key, merge within the current indexing run before asserting to the graph.

This is not cross-document entity normalization.

It is a local cleanup pass for one document batch.

### Where to change

- new helper recommended:
  - `services/indexing/src/lib/mergeExtractionBatch.ts`
- workflow call site:
  - `services/indexing/src/workflows/indexDocument.ts`

### Merge keys by class

Recommended initial map:

```ts
const MERGE_KEYS_BY_TYPE: Record<string, string[]> = {
  GeographicArea: ["fipsCode", "geoid", "cbsaCode"],
  State: ["fipsCode", "geoid"],
  County: ["fipsCode", "geoid"],
  CensusTract: ["fipsCode", "geoid"],
  MetropolitanStatisticalArea: ["cbsaCode"],
  ReportDocument: ["seriesCode"],
  CensusSurvey: ["surveyName", "surveyVintage", "surveyMethodology"],
  StatisticalMeasure: ["measureName"],
  PopulationGroup: ["characteristicType", "characteristicValue", "ombCode"],
};
```

### Merge behavior

If two extracted entities in the same batch share the same:

- type
- non-empty identity-key values

then:

- keep one canonical batch entity
- merge attributes
- rewrite relationship subject/object indices to the canonical entity

Do not merge:

- cross-type entities
- entities with conflicting key values
- entities with no strong key

### Example merge helper shape

```ts
export interface MergeExtractionBatchOutput {
  entities: ExtractionEntity[];
  relationships: ExtractionRelationship[];
  mergeWarnings: string[];
}
```

---

## 11. Namespace Consistency Workstream

### Policy

All ontology terms, rule prefixes, and runtime constants should use:

```text
http://localhost:4321/ontology/
```

This applies to:

- ontology TTL
- rules TTL
- binding YAML ontology IRIs
- backend namespace constants
- indexing namespace constants
- SPARQL snippets in runtime code
- web UI ontology constants

### Important note

Do not hand-edit generated build outputs.

Do not edit:

- `services/indexing/dist/...`
- `services/web/dist/...`

These should be regenerated from source after source changes are complete.

### Runtime-critical source files to change

#### Ontology and rules

- `ontology/economic-census/core.ttl`
- `ontology/economic-census/rules/forward.ttl`
- `ontology/economic-census/rules/backward.ttl`
- `ontology/public-health/core.ttl`
- `ontology/public-health/rules/forward.ttl`
- `ontology/public-health/rules/backward.ttl`

#### Binding YAML

- `ontology/economic-census/bigquery-bindings.yaml`
- `ontology/public-health/bigquery-bindings.yaml`

#### Backend

- `services/backend/src/main/java/com/unconcealment/backend/controller/IngestController.java`
- `services/backend/src/main/java/com/unconcealment/backend/service/OntologyLoaderService.java`
- `services/backend/src/main/java/com/unconcealment/backend/service/query/ReasoningAssetService.java`

#### Indexing

- `services/indexing/src/activities/normalizeEntitiesShared.ts`
- `services/indexing/src/activities/deleteGraphAssertions.ts`
- `services/indexing/src/activities/rollbackIndexing.ts`

#### Web

- `services/web/src/pages/entity/[dataset]/[uuid].astro`
- `services/web/src/pages/dataset/[id]/entities.astro`
- `services/web/src/pages/dataset/[id]/documents.astro`
- `services/web/src/pages/dataset/[id]/normalization.astro`
- `services/web/src/pages/dataset/[id]/rules.astro`
- `services/web/src/components/ReasoningPlayground.tsx`

### Documentation files to update after code rollout

- `docs/decisions/semantic-binding.md`
- `docs/runbook/2026-04-06-phase-implementation.md`
- `docs/runbook/2026-04-07-phase3-normalization.md`
- `docs/runbook/2026-04-08-recursive-backward-chaining-implementation.md`

### Example code changes

#### Java constant

```java
private static final String ONTOLOGY_NS = "http://localhost:4321/ontology/";
```

#### TypeScript constant

```ts
export const ONTOLOGY_NS = "http://localhost:4321/ontology/";
```

#### Turtle prefix

```turtle
@prefix ex: <http://localhost:4321/ontology/> .
```

---

## 12. File-by-File Implementation Plan

### 12.1 `services/backend/src/main/java/com/unconcealment/backend/model/DatasetManifest.java`

**Change**

- add `tboxCandidates()` to `NamedGraphs`

**Why**

- candidate graph needs a first-class named graph accessor

**Snippet**

```java
public String tboxCandidates() { return "urn:" + datasetId + ":tbox:candidates"; }
```

### 12.2 `services/indexing/src/config/manifest.ts`

**Change**

- add `tboxCandidates` to the `NamedGraphs` interface and `namedGraphs()` helper

**Why**

- indexing pipeline needs the same named graph constant as backend

**Snippet**

```ts
export interface NamedGraphs {
  tbox: string;
  tboxCandidates: string;
  rulesForward: string;
  rulesBackward: string;
  aboxAsserted: string;
  aboxInferred: string;
  normalization: string;
  provenance: string;
  systemHealth: string;
}
```

### 12.3 `services/indexing/src/constants/pipeline.ts`

**Change**

- replace flat ontology context query
- rewrite prompt builder to separate curated ontology and candidate vocabulary
- replace generic example with domain-native extraction example

**Why**

- the extractor needs ontology frames, not just vocabulary labels

### 12.4 `services/indexing/src/activities/extractEntities.ts`

**Change**

- fetch richer ontology guidance
- fetch candidate vocabulary separately
- pass both into the prompt builder

**Why**

- extraction guidance should distinguish curated vs candidate terms

### 12.5 `services/indexing/src/activities/softValidateExtraction.ts` (new)

**Change**

- add warning-only semantic validation
- identify unknown terms
- emit candidate term records

**Why**

- preserve open-world behavior while making extraction reviewable

### 12.6 `services/indexing/src/activities/persistCandidateTerms.ts` (new)

**Change**

- write candidate terms into `urn:{datasetId}:tbox:candidates`
- use existing `POST /query/update`

**Why**

- unknown vocabulary must be visible and queryable

### 12.7 `services/indexing/src/activities/index.ts`

**Change**

- export new activities

### 12.8 `services/indexing/src/workflows/indexDocument.ts`

**Change**

- add `mergeExtractionBatch`
- add `softValidateExtraction`
- add `persistCandidateTerms`
- keep `assertToGraph` unchanged in semantics

**Why**

- this is the orchestration point where the new planning stages belong

**Target insertion point**

Between flattening and `assertToGraph`.

### 12.9 `services/backend/src/main/java/com/unconcealment/backend/controller/IngestController.java`

**Change**

- standardize namespace constant
- keep warning-only semantics for unknown terms

**Important**

No auto-repair logic should be added here.

This endpoint should remain open-world and assertion-focused.

### 12.10 `services/backend/src/main/java/com/unconcealment/backend/service/OntologyLoaderService.java`

**Change**

- standardize ontology namespace in health-event SPARQL

**Important**

No candidate graph loading logic is needed here because candidate terms are runtime-written, not startup-loaded.

### 12.11 `services/indexing/src/lib/mergeExtractionBatch.ts` (new)

**Change**

- add ontology-aware same-document merge helper

**Why**

- reduce duplicates before graph assertion and normalization

---

## 13. Implementation Checklist

### Phase A: Namespace consistency

- [x] Standardize all source ontology prefixes to `http://localhost:4321/ontology/`
- [x] Standardize all rule prefixes to `http://localhost:4321/ontology/`
- [x] Standardize all runtime ontology constants in backend, indexing, and web
- [x] Standardize BigQuery binding YAML ontology IRIs
- [ ] Exclude generated `dist/` outputs from manual edits

### Phase B: Candidate graph plumbing

- [ ] Add `tboxCandidates()` to backend named graph helpers
- [ ] Add `tboxCandidates` to indexing named graph helpers
- [ ] Define candidate vocabulary RDF model
- [ ] Add `persistCandidateTerms` activity using `POST /query/update`

### Phase C: Richer ontology guidance

- [x] Replace flat ontology query with richer class/property frame query
- [x] Keep extraction-facing TBox queries scoped to ontology graph only
- [x] Remove rule schema declarations from `ontology/economic-census/core.ttl`
- [ ] Add candidate graph lookup for prompt context
- [ ] Split prompt into curated ontology and candidate vocabulary sections
- [x] Replace generic prompt example with ontology-native example

### Phase D: Soft semantic validation

- [ ] Add `softValidateExtraction` activity
- [ ] Emit warning records for unknown and near-match terms
- [ ] Emit warning records for domain/range and literal/object mismatches
- [ ] Do not rewrite extraction output
- [ ] Do not fail ingestion on semantic warnings

### Phase E: Ontology-aware merge

- [ ] Add merge helper keyed by ontology identity attributes
- [ ] Merge strong-key duplicates within one document batch
- [ ] Rewrite relationship indices after merge
- [ ] Log merge warnings for conflicting keys

### Phase F: Documentation and follow-up

- [ ] Update semantic-binding doc examples to new namespace policy
- [ ] Update earlier runbooks to new namespace policy
- [ ] Add a review query page or admin query for `tbox:candidates`

---

## 14. Example Queries for Review

### List candidate terms for a dataset

```sparql
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?term ?kind ?label ?status ?count ?warningCode WHERE {
  GRAPH <urn:economic-census:tbox:candidates> {
    ?term a ex:CandidateTerm ;
          ex:candidateKind ?kind ;
          ex:status ?status ;
          ex:occurrenceCount ?count ;
          ex:warningCode ?warningCode .
    OPTIONAL { ?term rdfs:label ?label }
  }
}
ORDER BY DESC(?count) ?kind ?label
```

### Find candidate terms with curated near-match suggestions

```sparql
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?term ?label ?match WHERE {
  GRAPH <urn:economic-census:tbox:candidates> {
    ?term a ex:CandidateTerm ;
          ex:suggestedCuratedMatch ?match .
    OPTIONAL { ?term rdfs:label ?label }
  }
}
ORDER BY ?label
```

### Inspect warning pressure by code

```sparql
PREFIX ex: <http://localhost:4321/ontology/>

SELECT ?warningCode (COUNT(*) AS ?n) WHERE {
  GRAPH <urn:economic-census:tbox:candidates> {
    ?term a ex:CandidateTerm ;
          ex:warningCode ?warningCode .
  }
}
GROUP BY ?warningCode
ORDER BY DESC(?n)
```

---

## 15. Non-Goals

This plan does not do the following:

- no SHACL gate at ingestion time
- no auto-repair of extracted unknown terms
- no destructive ontology refactor into shared core in this pass
- no cross-dataset normalization changes
- no SPARQL-to-SQL execution changes for BigQuery
- no forced migration of candidate terms into curated ontology without review

---

## 16. Recommended Execution Order

1. Namespace consistency first.
2. Named graph helper additions second.
3. Richer ontology guidance third.
4. Soft validation and candidate persistence fourth.
5. Ontology-aware merge fifth.
6. UI/admin visibility for candidate graph last.

This order minimizes confusion because:

- namespace policy affects every other layer
- candidate graph helpers are needed before persistence
- richer guidance improves extraction quality before warnings are evaluated
- merge should be added after extraction output shape is stable

---

## 17. Summary

The intended design is:

- ontology remains authoritative but not closed-world
- unknown terms are preserved and recorded in `urn:{datasetId}:tbox:candidates`
- semantic validation produces warnings, not failures
- extraction is guided by semantic frames, not flat term lists
- same-document duplicates are merged before assertion when ontology identity keys are available
- every ontology-facing component adopts the same namespace policy: `http://localhost:4321/ontology/`

This gives the system an explicit open-world vocabulary workflow instead of relying on silent fallback behavior.
