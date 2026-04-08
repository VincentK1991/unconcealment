# Recursive Backward Chaining with Apache Jena
> **Created**: 2026-04-08
> **Status**: Research / implementation guidance
> **Goal**: Support recursive backward chaining with Apache Jena rules in the reasoning playground and backend without `OutOfMemoryError` or non-terminating query behavior.
> **Relates to**: `services/backend/src/main/java/com/unconcealment/backend/controller/QueryController.java`

---

## Executive Summary

Apache Jena does support recursive backward chaining, but only safely when the recursive predicate is **tabled**.

For this codebase, the right design is:

1. Allow recursive backward rules only when the recursive predicate is explicitly tabled with `table(P)` or `tableAll()`.
2. Reject query shapes that Jena explicitly warns can explode table space, especially variable-predicate patterns like `(?s ?p ?o)` against a model containing tabled recursive predicates.
3. Keep a **fresh `InfModel` per request**, and call `reset()` after execution to discard memo tables.
4. Keep the existing result cap, and add an explicit query timeout using ARQ's timeout-capable execution builder.
5. Prefer `table(P)` over `tableAll()` so only the recursive predicate is memoized.

The current playground code does not yet implement that. It currently rejects all recursive rules outright in `QueryController.queryPlayground`.

---

## Primary Sources

These are the Jena references that matter for future implementation work.

### 1. Jena inference overview and rule engine

- https://jena.apache.org/documentation/inference/index.html

Relevant points from this page:

- The generic rule reasoner supports **forward chaining, backward chaining, and hybrid mode**.
- The backward engine is a **logic programming / datalog-style engine**.
- Recursive backward rules are supported through **tabling**.
- `table(P)` and `tableAll()` are the documented mechanisms for memoization.
- Jena explicitly warns that if any property is tabled, goals like `(A, ?P, ?X)` can cause broad tabling and memory growth.
- Jena states that tabled results are retained until `reset()` or model update.

This is the single most important document for this work.

### 2. `GenericRuleReasoner` Javadoc

- https://jena.apache.org/documentation/javadoc/jena/org.apache.jena.core/org/apache/jena/reasoner/rulesys/GenericRuleReasoner.html

Relevant points:

- `GenericRuleReasoner` supports `FORWARD`, `BACKWARD`, `FORWARD_RETE`, and `HYBRID`.
- `setMode(GenericRuleReasoner.RuleMode)` controls engine behavior.
- In pure `FORWARD` or `BACKWARD` mode, rules are interpreted in that direction regardless of how the arrow was written.
- In `HYBRID` mode, rule direction matters and forward rules can generate backward rules.

### 3. `FBRuleReasoner` Javadoc

- https://jena.apache.org/documentation/javadoc/jena/org.apache.jena.core/org/apache/jena/reasoner/rulesys/FBRuleReasoner.html

Relevant points:

- `FBRuleReasoner` is the base rule reasoner used by `GenericRuleReasoner`.
- It exposes `tablePredicate(Node predicate)`.
- Javadoc note: using the rule-set-level `table(...)` directive is preferred over manually calling `tablePredicate(...)` in Java.

### 4. `table(P)` builtin Javadoc

- https://jena.apache.org/documentation/javadoc/jena/org.apache.jena.core/org/apache/jena/reasoner/rulesys/builtins/Table.html

Relevant point:

- The builtin exists specifically to arrange that the given predicate is tabled by the backchaining engine.

### 5. `tableAll()` builtin Javadoc

- https://jena.apache.org/documentation/javadoc/jena/org.apache.jena.core/org/apache/jena/reasoner/rulesys/builtins/TableAll.html

Relevant point:

- `tableAll()` causes all backchaining goals to be tabled.
- This is valid, but much broader than `table(P)` and therefore more memory-sensitive.

### 6. `InfModel` Javadoc

- https://jena.apache.org/documentation/javadoc/jena/org.apache.jena.core/org/apache/jena/rdf/model/InfModel.html

Relevant points:

- `prepare()` performs up-front processing and caching where applicable.
- `reset()` clears internal caches.
- Javadoc explicitly calls out the tabled backchainer as a system that retains information after queries and benefits from `reset()` to prevent unbounded memory growth.

### 7. ARQ timeout support

- https://jena.apache.org/documentation/javadoc/arq/org.apache.jena.arq/org/apache/jena/query/QueryExecutionDatasetBuilder.html
- https://jena.apache.org/documentation/javadoc/arq/org.apache.jena.arq/org/apache/jena/query/QueryExecutionBuilder.html
- https://jena.apache.org/documentation/javadoc/arq/org.apache.jena.arq/org/apache/jena/query/ARQ.html

Relevant points:

- The builder APIs expose `timeout(...)`, `initialTimeout(...)`, and `overallTimeout(...)`.
- ARQ also exposes the `ARQ.queryTimeout` context symbol.
- Timeout support should be applied at query execution time as a separate safety mechanism from result caps and tabling.

---

## What Jena Actually Supports

### Recursive backward rules are valid

Jena's backward engine supports recursion using **SLG/tabling** semantics. This is the documented path for transitive closure and similar recursive logic.

Jena's own example is effectively:

```text
-> table(rdfs:subClassOf).
[r1: (?A rdfs:subClassOf ?C) <- (?A rdfs:subClassOf ?B) (?B rdfs:subClassOf ?C)]
```

The Jena docs explicitly state that without the `table(...)` line, this rule would be an infinite loop.

### Tabling is per predicate

Jena tables goals based on the **predicate** in the triple pattern.

That means:

- `table(<https://kg.unconcealment.io/ontology/conductedBy>)` is the narrow, preferred form.
- `tableAll()` is broader and should be reserved for exceptional cases.

### Tabled results stay in memory

This is critical for avoiding OOM:

- Jena keeps tabled results after a query.
- That behavior improves reuse across related queries.
- It also grows memory over time unless the model is reset or discarded.

For a per-request playground model, the safe pattern is:

1. create `InfModel`
2. execute one query
3. serialize results
4. call `reset()` in `finally`
5. let the request-scoped model go out of scope

### Open predicate queries are explicitly dangerous

Jena's docs warn that if any property is tabled, a goal such as:

```text
(A, ?P, ?X)
```

may cause all such goals to be tabled because `?P` might match a tabled property.

For this backend, that means queries like these should be rejected when recursive+tabled rules are present:

```sparql
SELECT ?s ?p ?o WHERE { ?s ?p ?o . }
SELECT ?s ?o WHERE { ?s ?p ?o . FILTER(?p = <...>) }
```

The safe shape is to keep the predicate fixed in the triple pattern itself:

```sparql
SELECT ?s ?o
WHERE {
  ?s <https://kg.unconcealment.io/ontology/conductedBy> ?o .
}
```

### Backward rules should have one consequent

The inference documentation states that backward rules can only have one consequent. That should be validated up front for any user-authored rule text intended for backward execution.

---

## Verified Local Findings

### Current backend behavior

The current code in `services/backend/src/main/java/com/unconcealment/backend/controller/QueryController.java` does **not** support recursive backward rules yet.

`queryPlayground(...)` currently:

- parses rules
- detects recursion by predicate overlap between rule head and body
- rejects all recursive rules with HTTP 400

Current error message:

```json
{
  "error": "Recursive rules are disabled in playground to prevent OutOfMemoryError. If the head predicate also appears in the body, rewrite the rule to be non-recursive or test the closure outside playground."
}
```

That guard exists because earlier experiments caused JVM heap exhaustion.

### Verified live-store candidate for recursive `conductedBy`

Against the live Fuseki dataset, this query returns one real candidate inferred triple:

```sparql
SELECT ?survey ?org ?parent
WHERE {
  GRAPH <urn:economic-census:abox:asserted> {
    ?survey <https://kg.unconcealment.io/ontology/conductedBy> ?org .
    ?org <https://kg.unconcealment.io/ontology/partOf> ?parent .
    FILTER(?survey != ?parent)
    FILTER NOT EXISTS {
      ?survey <https://kg.unconcealment.io/ontology/conductedBy> ?parent
    }
  }
}
LIMIT 20
```

Observed result:

- `2020 Census` `conductedBy` `U.S. Census Bureau`
- `U.S. Census Bureau` `partOf` `U.S. Department of Commerce`
- therefore one missing candidate: `2020 Census` `conductedBy` `U.S. Department of Commerce`

This is useful as a future regression test for recursive backward chaining support.

### Important data-quality note

The live data also contains at least one problematic edge:

- `U.S. Census Bureau partOf 2020 Census`

That edge makes naive recursive rules much more dangerous because it creates unintended self- or cycle-like derivations. Any recursive `conductedBy` example should include:

```text
notEqual(?survey, ?parent)
```

and, ideally, the underlying `partOf` data should be corrected.

---

## Recommended Backend Design

### 1. Replace the blanket recursion ban with a table-aware validator

Current behavior is too coarse. The validator should do this instead:

1. Parse the rule set.
2. Detect recursive predicates.
3. Allow recursion only if each recursive predicate is explicitly tabled via:
   - `table(<predicate>)`, or
   - `tableAll()`
4. Reject recursive rules that are not tabled.

Recommended error message:

```text
Recursive backward rules require explicit tabling in Jena.
Add -> table(<predicate>). for each recursive predicate, or use tableAll().
```

### 2. Prefer explicit `table(P)` over implicit Java-side mutation

Possible implementation choices:

- Accept only rule-text `table(...)`
- Or auto-call `reasoner.tablePredicate(...)` in Java after parsing

Recommended choice:

- require explicit `table(...)` in rule text

Reason:

- it matches Jena's documented mechanism
- it keeps rule semantics visible to users
- it avoids silently changing execution behavior

### 3. Reject unsafe query shapes when recursive+tabled rules are present

When a request contains recursive+tabled rules, reject queries that use a variable predicate in any triple pattern sent to the `InfModel`.

At minimum reject:

- `?s ?p ?o`
- `?x ?p <fixed>`
- `<fixed> ?p ?x`

Recommended rule:

- if the query contains any triple pattern whose predicate is a variable, return `400`

This follows the Jena documentation warning directly.

### 4. Keep result caps and add explicit timeouts

Current `PLAYGROUND_MAX_LIMIT` logic should remain.

Add query timeout on top of that:

- use ARQ's timeout-capable builder API
- prefer an overall timeout for the playground route
- log timeout separately from parse or inference errors

Result caps protect result serialization. Timeouts protect evaluation latency. They solve different failure modes.

### 5. Always reset the inference model after query execution

Because Jena retains tabled results, add:

```java
finally {
    infModel.reset();
}
```

or equivalent cleanup after execution completes.

In this codebase, the model is already request-scoped, which is good. `reset()` is still worthwhile because the request may serialize a large table and the cleanup point should be explicit.

### 6. Use pure `BACKWARD` for recursive backward playground runs

For the playground, the simplest safe execution model is:

- pure `BACKWARD` mode for backward-only recursive+tabled rule sets
- pure `FORWARD` for forward-only rule sets
- reserve `HYBRID` for cases where mixed rule directions are genuinely needed

Why:

- `HYBRID` has more moving parts
- this codebase already observed OOM when large ABox data was combined with `HYBRID`
- the playground benefit is predictable behavior, not maximal engine flexibility

Note that Jena interprets rules according to the configured pure mode regardless of arrow syntax. If preserving arrow semantics inside mixed rule sets matters, then `HYBRID` is required, but that should be a later step.

---

## Proposed Implementation Plan

### Phase 1: Safe recursive backward support in playground

1. Detect recursive predicates from parsed rules.
2. Detect `table(...)` / `tableAll()` declarations from rule text.
3. If recursive predicate exists and is not tabled, reject.
4. If recursive+tabled rules exist and query has a variable predicate, reject.
5. Build `GenericRuleReasoner` in `BACKWARD` mode.
6. Execute via timeout-capable ARQ query execution builder.
7. Return inferred results and base results as today.
8. Call `infModel.reset()` in `finally`.

### Phase 2: Better diagnostics

Add structured debug logging:

- recursive predicates detected
- tabled predicates detected
- chosen rule mode
- whether query had variable predicate patterns
- query timeout vs. normal completion
- counts for `queryResults` and `baseResults`

This is necessary for debugging future user-authored rule sets.

### Phase 3: Curated recursive example in the UI

Once backend support exists, add a verified example like:

```text
-> table(<https://kg.unconcealment.io/ontology/conductedBy>).

[conductedByParent:
  (?survey <https://kg.unconcealment.io/ontology/conductedBy> ?parent)
  <- (?survey <https://kg.unconcealment.io/ontology/conductedBy> ?org),
     (?org <https://kg.unconcealment.io/ontology/partOf> ?parent),
     notEqual(?survey, ?parent)]
```

with a fixed-predicate query that asks specifically for:

- `2020 Census`
- `conductedBy`
- `U.S. Department of Commerce`

Do not ship an example that relies on `?s ?p ?o` against recursive+tabled predicates.

---

## Example Rule and Query for Future Verification

### Rule

```text
-> table(<https://kg.unconcealment.io/ontology/conductedBy>).

[conductedByParent:
  (?survey <https://kg.unconcealment.io/ontology/conductedBy> ?parent)
  <- (?survey <https://kg.unconcealment.io/ontology/conductedBy> ?org),
     (?org <https://kg.unconcealment.io/ontology/partOf> ?parent),
     notEqual(?survey, ?parent)]
```

### Query

```sparql
SELECT ?s ?p ?o
WHERE {
  ?s <https://kg.unconcealment.io/ontology/conductedBy> ?o .
  FILTER(?s = <http://localhost:4321/entity/economic-census/2020-census-6a48b14a>)
  FILTER(?o = <http://localhost:4321/entity/economic-census/u-s-department-of-commerce-bc058b77>)
  BIND(<https://kg.unconcealment.io/ontology/conductedBy> AS ?p)
}
LIMIT 10
```

Expected inferred-only result:

- `http://localhost:4321/entity/economic-census/2020-census-6a48b14a`
- `https://kg.unconcealment.io/ontology/conductedBy`
- `http://localhost:4321/entity/economic-census/u-s-department-of-commerce-bc058b77`

---

## Risks and Non-Goals

### `tableAll()` is not the default answer

`tableAll()` is valid, but it is broader than needed and can increase memory pressure significantly. Prefer `table(P)` for specific recursive predicates.

### Result limits do not solve closure size

`LIMIT 20` helps response size. It does not guarantee low inference cost. If the closure itself is large or the query shape is too open, the engine can still do substantial work before producing the first rows.

### Cyclic or semantically bad data still matters

Tabling prevents infinite recursion. It does not make bad graph structure harmless. A cyclic or semantically wrong `partOf` graph can still produce large or surprising closures.

### Playground is not the same as persistent materialization

Request-scoped backward reasoning is for exploration. If users need stable large closures, forward materialization into a named graph is still the better operational model.

---

## Recommended Next Change in Code

Replace the blanket recursive-rule rejection in `QueryController.queryPlayground(...)` with:

1. recursive predicate detection
2. explicit tabled-predicate validation
3. unsafe-query-shape rejection
4. timeout-backed backward execution
5. `InfModel.reset()` cleanup

That will align the implementation with Jena's documented model rather than working against it.
