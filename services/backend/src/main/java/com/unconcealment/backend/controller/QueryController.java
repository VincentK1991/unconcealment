package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.OntologyLoaderService;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.rdf.model.InfModel;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.reasoner.rulesys.GenericRuleReasoner;
import org.apache.jena.reasoner.rulesys.Rule;
import org.apache.jena.update.UpdateFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * SPARQL query and update gateway. All consumers (web UI, MCP tools, CLI) route through here.
 * Never exposes Fuseki directly — all queries go through this controller.
 *
 * Routes:
 *   POST /query/raw?dataset={id}       → TDB2 directly, no inference
 *   POST /query/tbox?dataset={id}      → TBox named graphs only (ontology + rules)
 *   POST /query/update?dataset={id}    → SPARQL UPDATE (INSERT/DELETE)
 *   POST /query/reasoned?dataset={id}  → raw for now; Phase 2 replaces with InfModel
 *   POST /query/text?dataset={id}      → stub; Phase 3 wires Jena-text
 *
 * All endpoints accept Content-Type: application/sparql-query (or plain text).
 * Responses are SPARQL 1.1 JSON (application/sparql-results+json).
 */
@RestController
@RequestMapping("/query")
public class QueryController {

    private static final Logger log = LoggerFactory.getLogger(QueryController.class);
    private static final long PLAYGROUND_MAX_LIMIT = 500L;

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> datasetConnections;
    private final OntologyLoaderService ontologyLoader;

    public QueryController(DatasetManifest manifest,
                           Map<String, RDFConnection> datasetConnections,
                           OntologyLoaderService ontologyLoader) {
        this.manifest = manifest;
        this.datasetConnections = datasetConnections;
        this.ontologyLoader = ontologyLoader;
    }

    // -------------------------------------------------------------------------
    // POST /query/raw
    // -------------------------------------------------------------------------

    /**
     * Executes SPARQL SELECT/ASK directly against TDB2 (no inference).
     * Use for: provenance lookup, health graph queries, ABox browsing.
     * Queries must use GRAPH clauses to access named graphs.
     */
    @PostMapping("/raw")
    public ResponseEntity<String> queryRaw(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        return executeSparqlSelect(dataset, sparql, "raw");
    }

    // -------------------------------------------------------------------------
    // POST /query/tbox
    // -------------------------------------------------------------------------

    /**
     * Executes SPARQL SELECT restricted to TBox named graphs (ontology + rules).
     * FROM clauses for tbox:ontology, tbox:rules:forward, tbox:rules:backward are
     * injected automatically — the caller does not need to specify them.
     * No inference applied.
     */
    @PostMapping("/tbox")
    public ResponseEntity<String> queryTbox(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        NamedGraphs graphs = ds.namedGraphs();
        String tboxSparql = injectFromClauses(sparql,
                graphs.tbox(), graphs.rulesForward(), graphs.rulesBackward());
        return executeSparqlSelect(dataset, tboxSparql, "tbox");
    }

    // -------------------------------------------------------------------------
    // POST /query/update
    // -------------------------------------------------------------------------

    /**
     * Executes a SPARQL UPDATE (INSERT DATA, DELETE DATA, etc.) against the dataset.
     * Used by the TypeScript indexing pipeline to assert triples with RDF-star provenance.
     */
    @PostMapping("/update")
    public ResponseEntity<String> queryUpdate(
            @RequestParam String dataset,
            @RequestBody String sparqlUpdate) {
        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);
        try {
            conn.update(UpdateFactory.create(sparqlUpdate));
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"ok\"}");
        } catch (Exception e) {
            log.error("[{}] SPARQL UPDATE failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    // -------------------------------------------------------------------------
    // POST /query/reasoned
    // -------------------------------------------------------------------------

    /**
     * Executes SPARQL against an in-memory InfModel with:
     *   - Forward rules (sameAs symmetry/transitivity/propagation, partOf, subClassOf) run at
     *     InfModel creation time (HYBRID mode pre-pass).
     *   - Backward rules (canonicalResolution, indicatorRegion) applied at query time.
     *
     * Input graphs merged into a single in-memory default graph:
     *   abox:asserted + normalization (+ abox:inferred if it exists).
     *
     * Important: the caller must NOT include GRAPH clauses — the InfModel has no named graphs.
     * Use /query/raw for named-graph-scoped queries.
     */
    @PostMapping("/reasoned")
    public ResponseEntity<String> queryReasoned(
            @RequestParam String dataset,
            @RequestBody String sparql) {

        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        RDFConnection conn = datasetConnections.get(dataset);
        NamedGraphs graphs = ds.namedGraphs();

        // Phase 2A-4 (runbook): build InfModel from normalization-only graph + backward rules.
        // Loading abox:asserted (554 triples) into GenericRuleReasoner HYBRID mode causes OOM
        // because the open ?p ?o pattern triggers backward-rule expansion across all predicates.
        // Current approach: load only the normalization graph (sameAs pairs + isCanonical markers)
        // for the InfModel, apply sameAs symmetry+transitivity so owl:sameAs queries resolve
        // bidirectionally, then execute the caller's SPARQL against the InfModel.
        // Property lookups (abox:asserted) must be done via /query/raw with GRAPH clauses.
        try {
            Model normModel = loadGraphIriTriples(conn, graphs.normalization());

            List<Rule> rules = new ArrayList<>();
            rules.addAll(loadRules(conn, graphs.rulesForward(), "ForwardRule", 30)); // symmetry + transitivity only
            rules.addAll(loadRules(conn, graphs.rulesBackward(), "BackwardRule", Integer.MAX_VALUE));

            GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
            reasoner.setMode(GenericRuleReasoner.HYBRID);

            InfModel infModel = ModelFactory.createInfModel(reasoner, normModel);

            Query query = QueryFactory.create(sparql);
            try (QueryExecution qExec = QueryExecutionFactory.create(query, infModel)) {
                ResultSet rs = qExec.execSelect();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ResultSetFormatter.outputAsJSON(out, rs);
                return ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType("application/sparql-results+json"))
                        .body(out.toString(StandardCharsets.UTF_8));
            }
        } catch (org.apache.jena.query.QueryParseException e) {
            log.warn("[{}] [reasoned] SPARQL parse error: {}", dataset, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString("SPARQL parse error: " + e.getMessage()) + "}");
        } catch (Exception e) {
            log.error("[{}] [reasoned] Query failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    /**
     * Loads IRI-subject triples from a named graph via CONSTRUCT, bypassing the GSP fetch path.
     *
     * conn.fetch() downloads Turtle from Fuseki, but our ABox graphs contain RDF-star reification
     * triples (_:b rdf:reifies <<...>>) whose triple-term objects use Turtle 1.2 <<...>> syntax.
     * The Jena GSP client uses the standard Turtle 1.1 parser which cannot parse these, resulting
     * in a RiotException: [L_TRIPLE].
     *
     * Running CONSTRUCT on Fuseki avoids this: Fuseki handles RDF-star natively and we only
     * project out the regular entity triples (FILTER(isIRI(?s)) excludes blank-node reification
     * subjects, which are the only blank-node subjects in our data model).
     */
    private Model loadGraphIriTriples(RDFConnection conn, String graphUri) {
        String constructSparql =
            "CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <" + graphUri + "> { " +
            "?s ?p ?o . FILTER(isIRI(?s)) } }";
        Model model = ModelFactory.createDefaultModel();
        try {
            Query q = QueryFactory.create(constructSparql);
            try (QueryExecution qe = conn.query(q)) {
                qe.execConstruct(model);
            }
        } catch (Exception e) {
            log.warn("[reasoned] Could not load IRI triples from {}: {}", graphUri, e.getMessage());
        }
        log.debug("[reasoned] Loaded {} triples from {}", model.size(), graphUri);
        return model;
    }

    /**
     * Fetches Jena rule bodies from a named TBox rule graph and parses them.
     * Rules are stored as ex:ForwardRule / ex:BackwardRule nodes with ex:ruleBody literals.
     * Prefix declarations are injected before parsing so rule bodies can use short prefixes.
     */
    private List<Rule> loadRules(RDFConnection conn, String graphUri, String ruleType, int maxOrder) {
        List<Rule> rules = new ArrayList<>();
        String orderFilter = (maxOrder < Integer.MAX_VALUE)
            ? "FILTER(!BOUND(?order) || ?order <= " + maxOrder + ") "
            : "";
        String loadSparql =
            "PREFIX ex: <https://kg.unconcealment.io/ontology/> " +
            "SELECT ?body ?order WHERE { GRAPH <" + graphUri + "> { " +
            "?r a ex:" + ruleType + " ; ex:ruleBody ?body . " +
            "OPTIONAL { ?r ex:ruleOrder ?order } " + orderFilter + "} } ORDER BY ?order";
        try {
            Query q = QueryFactory.create(loadSparql);
            try (QueryExecution qe = conn.query(q)) {
                ResultSet rs = qe.execSelect();
                String prefixes =
                    "@prefix ex:   <https://kg.unconcealment.io/ontology/> .\n" +
                    "@prefix owl:  <http://www.w3.org/2002/07/owl#> .\n" +
                    "@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n" +
                    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n";
                while (rs.hasNext()) {
                    String body = rs.next().getLiteral("body").getString();
                    try {
                        rules.addAll(Rule.parseRules(prefixes + body));
                    } catch (Exception e) {
                        log.warn("[reasoned] Failed to parse {}: {} — {}", ruleType, body, e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[reasoned] Could not load {} from {}: {}", ruleType, graphUri, e.getMessage());
        }
        log.debug("[reasoned] Loaded {} rules from {} ({})", rules.size(), graphUri, ruleType);
        return rules;
    }

    // -------------------------------------------------------------------------
    // POST /query/playground
    // -------------------------------------------------------------------------

    /**
     * Runtime backward-chaining sandbox. Accepts custom Jena rules + a SPARQL SELECT
     * query, builds an ephemeral InfModel from abox:asserted, and returns:
     *   - queryResults: W3C SPARQL JSON results for the SELECT query
     *   - inferredTriples: triples present in the InfModel but absent from the base model (diff)
     *
     * Rules are ephemeral — not stored in the RDF store. No persistence.
     * Caller supplies rules in Jena rule syntax; an empty string means no custom rules.
     */
    @PostMapping(value = "/playground", consumes = "application/json")
    public ResponseEntity<String> queryPlayground(
            @RequestParam String dataset,
            @RequestBody PlaygroundRequest req) {

        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);

        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        // 1. Parse custom rules
        List<Rule> rules;
        try {
            String ruleText = (req.rules() == null || req.rules().isBlank()) ? "[]" : req.rules();
            rules = Rule.parseRules(ruleText);
        } catch (Exception e) {
            log.warn("[{}] [playground] Rule parse error: {}", dataset, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString("Rule parse error: " + e.getMessage()) + "}");
        }

        // 2. Load base model from abox:asserted (IRI-subject triples only, avoids RDF-star parse issue)
        NamedGraphs graphs = ds.namedGraphs();
        Model base = loadGraphIriTriples(conn, graphs.aboxAsserted());
        long baseSize = base.size();

        // 3. Build InfModel in FORWARD mode for playground safety.
        //    BACKWARD mode can explode memory with recursive custom rules (e.g. transitivity),
        //    which is common in playground experimentation.
        GenericRuleReasoner.RuleMode reasonerMode = GenericRuleReasoner.FORWARD;
        GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
        reasoner.setMode(reasonerMode);
        InfModel infModel = ModelFactory.createInfModel(reasoner, base);
        infModel.prepare();

        // 4. Parse + cap user query once, then execute against inferred and base models.
        Query query;
        try {
            query = QueryFactory.create(req.query());
        } catch (org.apache.jena.query.QueryParseException e) {
            log.warn("[{}] [playground] SPARQL parse error: {}", dataset, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString("SPARQL parse error: " + e.getMessage()) + "}");
        }
        enforcePlaygroundLimit(query);

        // 5. Execute user SPARQL SELECT against the InfModel
        String queryResultsJson;
        try {
            try (QueryExecution qExec = QueryExecutionFactory.create(query, infModel)) {
                ResultSet rs = qExec.execSelect();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ResultSetFormatter.outputAsJSON(out, rs);
                queryResultsJson = out.toString(StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            log.error("[{}] [playground] Query failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }

        // 6. Run the SAME query against the base model (no inference) to produce the diff client-side.
        //    We deliberately do NOT call infModel.listStatements() — an open ?s ?p ?o scan against a
        //    BACKWARD-mode InfModel forces the LP reasoner to attempt every possible triple, which
        //    causes OOM on any non-trivial dataset. Running the user's scoped SELECT against the base
        //    model is safe because the query pattern is bounded by the user's own WHERE clause.
        String baseResultsJson;
        try {
            try (QueryExecution qExec = QueryExecutionFactory.create(query, base)) {
                ResultSet rs = qExec.execSelect();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ResultSetFormatter.outputAsJSON(out, rs);
                baseResultsJson = out.toString(StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            // Non-fatal: diff view will be unavailable but table/graph still work
            log.warn("[{}] [playground] Base query failed (diff unavailable): {}", dataset, e.getMessage());
            baseResultsJson = "{\"head\":{\"vars\":[]},\"results\":{\"bindings\":[]}}";
        }

        log.debug("[{}] [playground] base={} triples, rules={}, mode=FORWARD, query executed",
                dataset, baseSize, rules.size());

        String body = "{\"queryResults\":" + queryResultsJson + ",\"baseResults\":" + baseResultsJson + "}";
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(body);
    }

    // -------------------------------------------------------------------------
    // POST /query/text
    // -------------------------------------------------------------------------

    /**
     * Two-hop full-text search: Jena-text index → candidate IRIs → canonical resolution.
     * Phase 3: wires Jena-text. Currently a stub.
     */
    @PostMapping("/text")
    public ResponseEntity<String> queryText(
            @RequestParam String dataset,
            @RequestBody String searchText) {
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                .contentType(MediaType.APPLICATION_JSON)
                .body("{\"error\":\"text search not yet implemented (Phase 3)\"}");
    }

    // -------------------------------------------------------------------------
    // POST /admin/reload
    // -------------------------------------------------------------------------

    /**
     * Hot-reloads ontology and rules for a dataset from TTL files into Fuseki.
     * Does not require a backend restart.
     */
    @PostMapping("/admin/reload")
    public ResponseEntity<String> adminReload(@RequestParam String dataset) {
        try {
            ontologyLoader.loadDataset(dataset);
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"reloaded\",\"dataset\":" + jsonString(dataset) + "}");
        } catch (Exception e) {
            log.error("Reload failed for dataset '{}': {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private ResponseEntity<String> executeSparqlSelect(String dataset, String sparql, String routeLabel) {
        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);
        try {
            Query query = QueryFactory.create(sparql);
            try (QueryExecution qExec = conn.query(query)) {
                ResultSet rs = qExec.execSelect();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ResultSetFormatter.outputAsJSON(out, rs);
                return ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType("application/sparql-results+json"))
                        .body(out.toString(StandardCharsets.UTF_8));
            }
        } catch (org.apache.jena.query.QueryParseException e) {
            log.warn("[{}] [{}] SPARQL parse error: {}", dataset, routeLabel, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString("SPARQL parse error: " + e.getMessage()) + "}");
        } catch (Exception e) {
            log.error("[{}] [{}] Query failed: {}", dataset, routeLabel, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    /**
     * Guards the playground endpoint against unbounded result serialization.
     * If no LIMIT is present, apply one. If a LIMIT is too high, cap it.
     */
    private void enforcePlaygroundLimit(Query query) {
        if (!query.isSelectType()) return;
        if (!query.hasLimit()) {
            query.setLimit(PLAYGROUND_MAX_LIMIT);
            return;
        }
        long current = query.getLimit();
        if (current <= 0 || current > PLAYGROUND_MAX_LIMIT) {
            query.setLimit(PLAYGROUND_MAX_LIMIT);
        }
    }

    /**
     * Detects recursive rules by checking whether any head predicate also appears in its body.
     * BACKWARD mode with recursive rules (e.g., transitive closure) can create huge search trees.
     */
    private boolean hasRecursiveRule(List<Rule> rules) {
        for (Rule rule : rules) {
            Set<String> headPredicates = new HashSet<>();
            for (Object head : rule.getHead()) {
                String pred = extractPredicateToken(head);
                if (pred != null) headPredicates.add(pred);
            }
            if (headPredicates.isEmpty()) continue;
            for (Object body : rule.getBody()) {
                String pred = extractPredicateToken(body);
                if (pred != null && headPredicates.contains(pred)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Extracts the predicate token from a rule clause string like:
     *   "(?a <https://.../partOf> ?b)" -> "<https://.../partOf>"
     * Returns null when the clause is not a triple pattern.
     */
    private String extractPredicateToken(Object clause) {
        if (clause == null) return null;
        String s = clause.toString().trim();
        if (!s.startsWith("(") || !s.endsWith(")")) return null;
        String inner = s.substring(1, s.length() - 1).trim();
        String[] parts = inner.split("\\s+");
        if (parts.length < 3) return null;
        return parts[1];
    }

    /**
     * Injects FROM clauses into a SPARQL SELECT query by rewriting the query AST.
     * The specified graph URIs are added as default-graph FROM clauses, merging
     * their contents into the default graph for this query execution only.
     */
    private String injectFromClauses(String sparql, String... graphUris) {
        try {
            Query query = QueryFactory.create(sparql);
            for (String uri : graphUris) {
                query.addGraphURI(uri);
            }
            return query.serialize();
        } catch (Exception e) {
            // If rewriting fails, fall back to the original query
            log.warn("FROM clause injection failed, using original query: {}", e.getMessage());
            return sparql;
        }
    }

    private DatasetConfig resolveDataset(String datasetId) {
        return manifest.getDatasets().stream()
                .filter(d -> d.getId().equals(datasetId))
                .findFirst()
                .orElse(null);
    }

    private ResponseEntity<String> datasetNotFound(String dataset) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .contentType(MediaType.APPLICATION_JSON)
                .body("{\"error\":\"Unknown dataset: " + dataset + "\"}");
    }

    /** Minimal JSON string escaping — avoids a Jackson dependency for simple messages. */
    private String jsonString(String value) {
        if (value == null) return "null";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }
}
