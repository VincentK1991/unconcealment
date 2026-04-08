---
name: sparql-query-pattern

description: Use this skill whenever you need to understand the current state of the knowledge graph — what data is indexed, what has been normalized, what the reasoner has produced, or how the ontology is structured.
---

## 1. Endpoints

### Always query Fuseki directly for inspection

```
http://localhost:3030/{dataset}/sparql    ← SPARQL SELECT / ASK / CONSTRUCT (GET or POST)
http://localhost:3030/{dataset}/update    ← SPARQL UPDATE (POST only)
http://localhost:3030/{dataset}/data      ← Graph Store Protocol (GET/PUT named graph)
```

Available datasets: `economic-census`, `public-health`

**Do NOT use `localhost:8080` for inspection.** The Java backend at port 8080 rewrites queries (injects `FROM NAMED` clauses, stubs out endpoints). Use it only to test what the web application actually sees.

### How to run a query from the shell

```bash
curl -s http://localhost:3030/economic-census/sparql \
  --data-urlencode "query=SELECT ..." \
  -H "Accept: application/sparql-results+json"
```

For SPARQL UPDATE:

```bash
curl -s -X POST http://localhost:3030/economic-census/update \
  --data-urlencode "update=DELETE ..." \
  -H "Content-Type: application/x-www-form-urlencoded"
```

---

## 2. Named Graph Conventions

All URNs follow: `urn:{dataset-id}:{graph-role}`

| Named Graph                    | Contents                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| `urn:{id}:abox:asserted`       | Extracted entities + RDF-star provenance annotations                    |
| `urn:{id}:abox:inferred`       | Materialized forward-rule inferences (Phase 2 — may not exist yet)      |
| `urn:{id}:normalization`       | `owl:sameAs` pairs + `ex:isCanonical` markers + reification annotations |
| `urn:{id}:tbox:ontology`       | OWL classes, object/datatype properties                                 |
| `urn:{id}:tbox:rules:forward`  | Forward Jena rules (materialized at ingest time)                        |
| `urn:{id}:tbox:rules:backward` | Backward Jena rules (applied at query time)                             |
| `urn:{id}:system:health`       | Ontology load events, operational metadata                              |

Replace `{id}` with `economic-census` or `public-health`.

---

## 3. Key Prefixes

```sparql
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
PREFIX ex:   <https://kg.unconcealment.io/ontology/>
PREFIX text: <http://jena.apache.org/text#>
```

Entity IRIs follow the pattern: `http://localhost:4321/entity/{dataset}/{slug}-{uuid8}`

---

## 4. Standard Inspection Queries

### List all named graphs

```sparql
SELECT DISTINCT ?g WHERE { GRAPH ?g {} } ORDER BY ?g
```

### Triple counts per named graph

```sparql
SELECT ?g (COUNT(*) AS ?triples)
WHERE { GRAPH ?g { ?s ?p ?o } }
GROUP BY ?g ORDER BY ?g
```

### Entity type distribution in abox:asserted

```sparql
SELECT ?type (COUNT(DISTINCT ?e) AS ?count)
WHERE {
  GRAPH <urn:economic-census:abox:asserted> { ?e a ?type }
}
GROUP BY ?type ORDER BY DESC(?count)
```

### All entities with labels

```sparql
SELECT DISTINCT ?e ?type ?label
WHERE {
  GRAPH <urn:economic-census:abox:asserted> {
    ?e a ?type ; rdfs:label ?label
  }
}
ORDER BY ?type ?label
```

---

## 5. Normalization Graph Queries

The normalization graph (`urn:{id}:normalization`) contains:

- `?subject owl:sameAs ?object` — directed equivalence pairs
- `?entity ex:isCanonical true` — elected canonical representative per cluster
- Blank-node reification on each pair: `?ann rdf:reifies << ?s owl:sameAs ?o >> ; ex:normalizationMethod ?m ; ex:confidence ?c ; ex:transactionTime ?t`

### Count sameAs pairs

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT (COUNT(*) AS ?pairs)
WHERE {
  GRAPH <urn:economic-census:normalization> {
    ?s owl:sameAs ?o . FILTER(?s != ?o)
  }
}
```

### Count entities that appear in any sameAs pair

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT (COUNT(DISTINCT ?e) AS ?normalizedEntities)
WHERE {
  GRAPH <urn:economic-census:normalization> {
    { ?e owl:sameAs ?x } UNION { ?x owl:sameAs ?e }
    FILTER(?e != ?x)
  }
}
```

### Canonical cluster view (canonical → members with labels)

```sparql
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX ex:   <https://kg.unconcealment.io/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?canonical ?canonLabel
       (COUNT(?member) AS ?clusterSize)
       (GROUP_CONCAT(?memberLabel; separator=" | ") AS ?members)
WHERE {
  GRAPH <urn:economic-census:normalization> {
    ?canonical ex:isCanonical true .
    ?member owl:sameAs ?canonical .
    FILTER(?member != ?canonical)
  }
  GRAPH <urn:economic-census:abox:asserted> {
    ?canonical rdfs:label ?canonLabel .
    ?member    rdfs:label ?memberLabel
  }
}
GROUP BY ?canonical ?canonLabel
ORDER BY DESC(?clusterSize)
```

### sameAs pairs with full provenance (via reification)

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX ex:  <https://kg.unconcealment.io/ontology/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?sLabel ?oLabel ?method ?confidence ?txTime
WHERE {
  GRAPH <urn:economic-census:normalization> {
    ?s owl:sameAs ?o . FILTER(?s != ?o)
    ?ann rdf:reifies << ?s owl:sameAs ?o >> ;
         ex:normalizationMethod ?method ;
         ex:confidence ?confidence ;
         ex:transactionTime ?txTime .
  }
  GRAPH <urn:economic-census:abox:asserted> {
    ?s rdfs:label ?sLabel .
    ?o rdfs:label ?oLabel .
  }
}
ORDER BY DESC(?confidence)
```

**Note on RDF-star storage**: Jena 5.x stores RDF-star using `rdf:reifies` (RDF 1.2 style) with blank nodes — not embedded `<< >>` triples. Each `owl:sameAs` pair generates ~5 annotation triples. The SPARQL pattern above using `rdf:reifies << ?s owl:sameAs ?o >>` is the correct way to query them.

### Entities NOT yet normalized (isolated, no sameAs presence)

```sparql
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?e ?type ?label
WHERE {
  GRAPH <urn:economic-census:abox:asserted> {
    ?e a ?type ; rdfs:label ?label
  }
  FILTER NOT EXISTS {
    GRAPH <urn:economic-census:normalization> {
      { ?e owl:sameAs ?x } UNION { ?x owl:sameAs ?e }
    }
  }
}
ORDER BY ?type ?label
```

---

## 6. ABox Provenance Queries

Every triple in `abox:asserted` has RDF-star provenance. The annotations sit on the asserted triple using `rdf:reifies`:

```sparql
PREFIX ex:  <https://kg.unconcealment.io/ontology/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?e ?p ?o ?method ?confidence ?sourceDoc ?txTime
WHERE {
  GRAPH <urn:economic-census:abox:asserted> {
    ?e ?p ?o .
    ?ann rdf:reifies << ?e ?p ?o >> ;
         ex:extractionMethod ?method ;
         ex:transactionTime  ?txTime .
    OPTIONAL { ?ann ex:confidence    ?confidence }
    OPTIONAL { ?ann ex:sourceDocument ?sourceDoc }
  }
  FILTER(?e = <http://localhost:4321/entity/economic-census/YOUR-ENTITY-IRI-HERE>)
}
```

---

## 7. TBox Queries

### List all OWL classes in the ontology

```sparql
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?class ?label
WHERE {
  GRAPH <urn:economic-census:tbox:ontology> {
    ?class a owl:Class .
    OPTIONAL { ?class rdfs:label ?label }
  }
}
ORDER BY ?class
```

### List all forward rules (ordered)

```sparql
PREFIX ex: <https://kg.unconcealment.io/ontology/>

SELECT ?rule ?name ?order ?body
WHERE {
  GRAPH <urn:economic-census:tbox:rules:forward> {
    ?rule a ex:ForwardRule ;
          ex:ruleName  ?name ;
          ex:ruleOrder ?order ;
          ex:ruleBody  ?body .
  }
}
ORDER BY ?order
```

### List all backward rules

```sparql
PREFIX ex: <https://kg.unconcealment.io/ontology/>

SELECT ?rule ?name ?body
WHERE {
  GRAPH <urn:economic-census:tbox:rules:backward> {
    ?rule a ex:BackwardRule ;
          ex:ruleName ?name ;
          ex:ruleBody ?body .
  }
}
```

---

## 8. Full-Text Search via Jena-text (Lucene)

The Lucene index covers `rdfs:label` and `rdfs:comment` across named graphs (requires `text:graphField "graph"` in Fuseki config — confirmed present in `infra/fuseki/config.ttl`).

```sparql
PREFIX text: <http://jena.apache.org/text#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?entity ?graph ?label ?score
WHERE {
  (?entity ?score ?label) text:query (rdfs:label "king county" 20) .
  GRAPH ?graph { ?entity rdfs:label ?label }
}
ORDER BY DESC(?score)
```

**Note**: After adding `text:graphField`, Fuseki must be restarted (or the Lucene index rebuilt) for existing triples to appear in search results.

---

## 9. Checking What the Reasoner Has Produced

### Does abox:inferred exist?

```sparql
SELECT (COUNT(*) AS ?inferredTriples)
WHERE { GRAPH <urn:economic-census:abox:inferred> { ?s ?p ?o } }
```

If this returns 0 or errors, `MaterializationService` has not run yet. This is expected in Phase 1.

### Verify owl:sameAs symmetry materialized (Phase 2 check)

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>

ASK {
  GRAPH <urn:economic-census:abox:inferred> {
    <http://localhost:4321/entity/economic-census/ENTITY-A> owl:sameAs
    <http://localhost:4321/entity/economic-census/ENTITY-B>
  }
}
```

---

## 10. Known Data Quality Issues (as of 2026-04-07)

- **False-positive sameAs pairs**: Jaro-Winkler auto-accepts pairs scoring ≥ 0.92. Year-bearing labels like "1930 Census" and "1990 Census" score ~0.95 but are distinct entities. The LLM judge is never reached for these — they fire before the threshold.
- **`abox:inferred` does not exist**: `MaterializationService` (Phase 2A-1) has not been implemented. Forward rules are loaded but never executed.
- **`public-health` has no abox data**: Only tbox graphs exist; no documents have been indexed into that dataset yet.
- **`/query/reasoned` is a pass-through**: It currently forwards to `/query/raw` — no inference is applied at query time.
