package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.OntologyLoaderService;
import org.apache.jena.graph.Node;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryCancelledException;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.reasoner.TriplePattern;
import org.apache.jena.rdf.model.InfModel;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.reasoner.rulesys.ClauseEntry;
import org.apache.jena.reasoner.rulesys.Functor;
import org.apache.jena.reasoner.rulesys.GenericRuleReasoner;
import org.apache.jena.reasoner.rulesys.Rule;
import org.apache.jena.sparql.core.TriplePath;
import org.apache.jena.sparql.syntax.ElementPathBlock;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
    private static final long PLAYGROUND_QUERY_TIMEOUT_MS = 15_000L;
    private static final Pattern TABLE_DIRECTIVE =
            Pattern.compile("\\btable\\s*\\(\\s*([^\\)]+?)\\s*\\)");
    private static final Pattern TABLE_ALL_DIRECTIVE =
            Pattern.compile("\\btableAll\\s*\\(\\s*\\)");

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
        String ruleText = (req.rules() == null || req.rules().isBlank()) ? "[]" : req.rules();
        try {
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

        // 3. Validate rule set + choose reasoner mode safely:
        //    - Forward-only rules run FORWARD.
        //    - Backward-only rules run BACKWARD.
        //    - Mixed-direction rule sets are rejected for now instead of silently changing semantics.
        //    - Recursive backward rules are allowed only when explicitly tabled.
        PlaygroundRuleAnalysis ruleAnalysis = analyzeRules(rules, ruleText);
        if (ruleAnalysis.hasBackwardRules() && ruleAnalysis.hasForwardRules()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(
                            "Mixed forward and backward rule sets are not supported in playground yet. " +
                            "Split the rules by direction so they can run in a single Jena reasoner mode."
                    ) + "}");
        }

        if (hasInvalidBackwardRuleConsequentCount(rules)) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(
                            "Backward rules must have exactly one consequent in Jena. " +
                            "Rewrite the backward rule so the head contains a single triple pattern or builtin."
                    ) + "}");
        }

        if (ruleAnalysis.hasRecursiveRules()) {
            if (!ruleAnalysis.hasBackwardRules()) {
                return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"error\":" + jsonString(
                                "Recursive rules are only supported in playground for backward chaining. " +
                                "Rewrite the recursive rule as a backward rule and add explicit table(<predicate>) directives."
                        ) + "}");
            }

            if (!ruleAnalysis.allRecursivePredicatesTabled()) {
                return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"error\":" + jsonString(
                                "Recursive backward rules require explicit tabling in Jena. " +
                                "Add -> table(<predicate>). for each recursive predicate, or use tableAll(). " +
                                "Missing table directives for: " + String.join(", ", ruleAnalysis.untabledRecursivePredicates())
                        ) + "}");
            }
        }

        GenericRuleReasoner.RuleMode reasonerMode = ruleAnalysis.hasBackwardRules()
                ? GenericRuleReasoner.BACKWARD
                : GenericRuleReasoner.FORWARD;
        GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
        reasoner.setMode(reasonerMode);
        InfModel infModel = ModelFactory.createInfModel(reasoner, base);
        if (reasonerMode == GenericRuleReasoner.FORWARD) {
            infModel.prepare();
        }

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

        if (ruleAnalysis.hasRecursiveRules() && hasUnsafeRecursiveQueryShape(query)) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(
                            "Recursive backward playground queries must use fixed predicates in triple patterns. " +
                            "Variable predicates and property paths are not allowed with tabled recursive rules."
                    ) + "}");
        }

        // 5. Execute user SPARQL SELECT against the InfModel
        String queryResultsJson;
        try {
            queryResultsJson = executeModelSelectAsJson(query, infModel);
        } catch (QueryCancelledException e) {
            log.warn("[{}] [playground] Inference query timed out after {} ms", dataset, PLAYGROUND_QUERY_TIMEOUT_MS);
            return ResponseEntity.status(HttpStatus.REQUEST_TIMEOUT)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(
                            "Playground query timed out after " + PLAYGROUND_QUERY_TIMEOUT_MS + " ms."
                    ) + "}");
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
            baseResultsJson = executeModelSelectAsJson(query, base);
        } catch (QueryCancelledException e) {
            log.warn("[{}] [playground] Base query timed out (diff unavailable) after {} ms",
                    dataset, PLAYGROUND_QUERY_TIMEOUT_MS);
            baseResultsJson = "{\"head\":{\"vars\":[]},\"results\":{\"bindings\":[]}}";
        } catch (Exception e) {
            // Non-fatal: diff view will be unavailable but table/graph still work
            log.warn("[{}] [playground] Base query failed (diff unavailable): {}", dataset, e.getMessage());
            baseResultsJson = "{\"head\":{\"vars\":[]},\"results\":{\"bindings\":[]}}";
        } finally {
            try {
                infModel.reset();
            } catch (Exception e) {
                log.debug("[{}] [playground] InfModel reset failed: {}", dataset, e.getMessage());
            }
        }

        String modeLabel = reasonerMode == GenericRuleReasoner.BACKWARD ? "BACKWARD" : "FORWARD";
        log.debug("[{}] [playground] base={} triples, rules={}, mode={}, recursive={}, tableAll={}, tabledPredicates={}, query executed",
                dataset, baseSize, rules.size(), modeLabel,
                ruleAnalysis.hasRecursiveRules(), ruleAnalysis.tableAll(), ruleAnalysis.tabledPredicates());

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

    private String executeModelSelectAsJson(Query query, Model model) {
        try (QueryExecution qExec = QueryExecution.model(model)
                .query(query)
                .timeout(PLAYGROUND_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()) {
            ResultSet rs = qExec.execSelect();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ResultSetFormatter.outputAsJSON(out, rs);
            return out.toString(StandardCharsets.UTF_8);
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

    private PlaygroundRuleAnalysis analyzeRules(List<Rule> rules, String ruleText) {
        boolean hasBackwardRules = false;
        boolean hasForwardRules = false;
        boolean tableAll = false;
        Set<String> recursivePredicates = new LinkedHashSet<>();
        Set<String> tabledPredicates = new LinkedHashSet<>();

        for (Rule rule : rules) {
            boolean hasTriplePattern = containsTriplePattern(rule.getHead()) || containsTriplePattern(rule.getBody());
            if (hasTriplePattern) {
                if (rule.isBackward()) {
                    hasBackwardRules = true;
                } else {
                    hasForwardRules = true;
                }
            }

            Set<String> headPredicates = extractRulePredicates(rule.getHead());
            Set<String> bodyPredicates = extractRulePredicates(rule.getBody());
            Set<String> overlap = new LinkedHashSet<>(headPredicates);
            overlap.retainAll(bodyPredicates);
            recursivePredicates.addAll(overlap);

            collectTableDirectivePredicates(rule.getHead(), tabledPredicates);
            collectTableDirectivePredicates(rule.getBody(), tabledPredicates);
            tableAll = tableAll || containsTableAllDirective(rule.getHead()) || containsTableAllDirective(rule.getBody());
        }

        if (!tableAll && ruleText != null && TABLE_ALL_DIRECTIVE.matcher(ruleText).find()) {
            tableAll = true;
        }
        if (tabledPredicates.isEmpty() && ruleText != null) {
            Matcher matcher = TABLE_DIRECTIVE.matcher(ruleText);
            while (matcher.find()) {
                tabledPredicates.add(normalizePredicateToken(matcher.group(1)));
            }
        }

        return new PlaygroundRuleAnalysis(
                hasBackwardRules,
                hasForwardRules,
                tableAll,
                Set.copyOf(recursivePredicates),
                Set.copyOf(tabledPredicates)
        );
    }

    private boolean hasInvalidBackwardRuleConsequentCount(List<Rule> rules) {
        for (Rule rule : rules) {
            boolean hasTriplePattern = containsTriplePattern(rule.getHead()) || containsTriplePattern(rule.getBody());
            if (hasTriplePattern && rule.isBackward() && rule.headLength() != 1) {
                return true;
            }
        }
        return false;
    }

    private boolean containsTriplePattern(ClauseEntry[] clauses) {
        for (ClauseEntry clause : clauses) {
            if (clause instanceof TriplePattern) {
                return true;
            }
        }
        return false;
    }

    private Set<String> extractRulePredicates(ClauseEntry[] clauses) {
        Set<String> predicates = new LinkedHashSet<>();
        for (ClauseEntry clause : clauses) {
            if (!(clause instanceof TriplePattern triplePattern)) {
                continue;
            }
            Node predicate = triplePattern.getPredicate();
            if (predicate == null || predicate.isVariable()) {
                continue;
            }
            predicates.add(normalizePredicateNode(predicate));
        }
        return predicates;
    }

    private void collectTableDirectivePredicates(ClauseEntry[] clauses, Set<String> tabledPredicates) {
        for (ClauseEntry clause : clauses) {
            if (!(clause instanceof Functor functor)) {
                continue;
            }
            if (!"table".equals(functor.getName()) || functor.getArgLength() != 1) {
                continue;
            }
            tabledPredicates.add(normalizePredicateNode(functor.getArgs()[0]));
        }
    }

    private boolean containsTableAllDirective(ClauseEntry[] clauses) {
        for (ClauseEntry clause : clauses) {
            if (clause instanceof Functor functor && "tableAll".equals(functor.getName())) {
                return true;
            }
        }
        return false;
    }

    private boolean hasUnsafeRecursiveQueryShape(Query query) {
        if (query.getQueryPattern() == null) {
            return false;
        }
        AtomicBoolean unsafe = new AtomicBoolean(false);
        ElementWalker.walk(query.getQueryPattern(), new ElementVisitorBase() {
            @Override
            public void visit(ElementPathBlock elementPathBlock) {
                elementPathBlock.patternElts().forEachRemaining(triplePath -> {
                    if (isUnsafeRecursiveTriplePattern(triplePath)) {
                        unsafe.set(true);
                    }
                });
            }
        });
        return unsafe.get();
    }

    private boolean isUnsafeRecursiveTriplePattern(TriplePath triplePath) {
        Node predicate = triplePath.getPredicate();
        return predicate == null || predicate.isVariable();
    }

    private String normalizePredicateNode(Node predicate) {
        if (predicate != null && predicate.isURI()) {
            return predicate.getURI();
        }
        return predicate == null ? "" : normalizePredicateToken(predicate.toString());
    }

    private String normalizePredicateToken(String token) {
        String normalized = token == null ? "" : token.trim();
        if (normalized.startsWith("<") && normalized.endsWith(">") && normalized.length() >= 2) {
            return normalized.substring(1, normalized.length() - 1);
        }
        return normalized;
    }

    private record PlaygroundRuleAnalysis(
            boolean hasBackwardRules,
            boolean hasForwardRules,
            boolean tableAll,
            Set<String> recursivePredicates,
            Set<String> tabledPredicates
    ) {
        boolean hasRecursiveRules() {
            return !recursivePredicates.isEmpty();
        }

        boolean allRecursivePredicatesTabled() {
            return tableAll || tabledPredicates.containsAll(recursivePredicates);
        }

        Set<String> untabledRecursivePredicates() {
            if (tableAll) {
                return Set.of();
            }
            Set<String> missing = new LinkedHashSet<>(recursivePredicates);
            missing.removeAll(tabledPredicates);
            return Set.copyOf(missing);
        }
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
