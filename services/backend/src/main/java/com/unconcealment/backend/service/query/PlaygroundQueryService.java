package com.unconcealment.backend.service.query;

import com.unconcealment.backend.controller.PlaygroundRequest;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryCancelledException;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.InfModel;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.reasoner.rulesys.GenericRuleReasoner;
import org.apache.jena.reasoner.rulesys.Rule;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class PlaygroundQueryService {

    private static final Logger log = LoggerFactory.getLogger(PlaygroundQueryService.class);
    private static final long PLAYGROUND_MAX_LIMIT = 500L;
    private static final long PLAYGROUND_QUERY_TIMEOUT_MS = 15_000L;
    private static final String EMPTY_RESULT_JSON = "{\"head\":{\"vars\":[]},\"results\":{\"bindings\":[]}}";

    private final ReasoningAssetService reasoningAssetService;
    private final SparqlQuerySupportService sparqlQuerySupportService;
    private final PlaygroundRuleAnalyzer playgroundRuleAnalyzer;

    public PlaygroundQueryService(ReasoningAssetService reasoningAssetService,
                                  SparqlQuerySupportService sparqlQuerySupportService,
                                  PlaygroundRuleAnalyzer playgroundRuleAnalyzer) {
        this.reasoningAssetService = reasoningAssetService;
        this.sparqlQuerySupportService = sparqlQuerySupportService;
        this.playgroundRuleAnalyzer = playgroundRuleAnalyzer;
    }

    public PlaygroundExecutionResult execute(String dataset,
                                             RDFConnection conn,
                                             NamedGraphs graphs,
                                             PlaygroundRequest req) {
        List<Rule> rules = parseRules(dataset, req);
        String ruleText = (req.rules() == null || req.rules().isBlank()) ? "[]" : req.rules();

        Model base = reasoningAssetService.loadGraphIriTriples(conn, graphs.aboxAsserted());
        long baseSize = base.size();

        PlaygroundRuleAnalysis ruleAnalysis = playgroundRuleAnalyzer.analyze(rules, ruleText);
        validateRuleSet(ruleAnalysis, rules);

        GenericRuleReasoner.RuleMode reasonerMode = ruleAnalysis.hasBackwardRules()
                ? GenericRuleReasoner.BACKWARD
                : GenericRuleReasoner.FORWARD;
        GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
        reasoner.setMode(reasonerMode);
        InfModel infModel = ModelFactory.createInfModel(reasoner, base);
        if (reasonerMode == GenericRuleReasoner.FORWARD) {
            infModel.prepare();
        }

        Query query = parseQuery(dataset, req.query());
        enforcePlaygroundLimit(query);

        if (ruleAnalysis.hasRecursiveRules() && playgroundRuleAnalyzer.hasUnsafeRecursiveQueryShape(query)) {
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST,
                    "Recursive backward playground queries must use fixed predicates in triple patterns. " +
                    "Variable predicates and property paths are not allowed with tabled recursive rules.");
        }

        String queryResultsJson;
        try {
            queryResultsJson = sparqlQuerySupportService.executeModelSelectAsJson(query, infModel, PLAYGROUND_QUERY_TIMEOUT_MS);
        } catch (QueryCancelledException e) {
            log.warn("[{}] [playground] Inference query timed out after {} ms", dataset, PLAYGROUND_QUERY_TIMEOUT_MS);
            throw new PlaygroundQueryException(HttpStatus.REQUEST_TIMEOUT,
                    "Playground query timed out after " + PLAYGROUND_QUERY_TIMEOUT_MS + " ms.");
        } catch (Exception e) {
            log.error("[{}] [playground] Query failed: {}", dataset, e.getMessage(), e);
            throw new PlaygroundQueryException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }

        String baseResultsJson;
        try {
            baseResultsJson = sparqlQuerySupportService.executeModelSelectAsJson(query, base, PLAYGROUND_QUERY_TIMEOUT_MS);
        } catch (QueryCancelledException e) {
            log.warn("[{}] [playground] Base query timed out (diff unavailable) after {} ms",
                    dataset, PLAYGROUND_QUERY_TIMEOUT_MS);
            baseResultsJson = EMPTY_RESULT_JSON;
        } catch (Exception e) {
            log.warn("[{}] [playground] Base query failed (diff unavailable): {}", dataset, e.getMessage());
            baseResultsJson = EMPTY_RESULT_JSON;
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

        return new PlaygroundExecutionResult(
                queryResultsJson,
                baseResultsJson,
                baseSize,
                rules.size(),
                modeLabel,
                ruleAnalysis
        );
    }

    private List<Rule> parseRules(String dataset, PlaygroundRequest req) {
        String ruleText = (req.rules() == null || req.rules().isBlank()) ? "[]" : req.rules();
        try {
            return Rule.parseRules(ruleText);
        } catch (Exception e) {
            log.warn("[{}] [playground] Rule parse error: {}", dataset, e.getMessage());
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST, "Rule parse error: " + e.getMessage());
        }
    }

    private Query parseQuery(String dataset, String sparql) {
        try {
            return QueryFactory.create(sparql);
        } catch (org.apache.jena.query.QueryParseException e) {
            log.warn("[{}] [playground] SPARQL parse error: {}", dataset, e.getMessage());
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST, "SPARQL parse error: " + e.getMessage());
        }
    }

    private void validateRuleSet(PlaygroundRuleAnalysis ruleAnalysis, List<Rule> rules) {
        if (ruleAnalysis.hasBackwardRules() && ruleAnalysis.hasForwardRules()) {
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST,
                    "Mixed forward and backward rule sets are not supported in playground yet. " +
                    "Split the rules by direction so they can run in a single Jena reasoner mode.");
        }

        if (playgroundRuleAnalyzer.hasInvalidBackwardRuleConsequentCount(rules)) {
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST,
                    "Backward rules must have exactly one consequent in Jena. " +
                    "Rewrite the backward rule so the head contains a single triple pattern or builtin.");
        }

        if (!ruleAnalysis.hasRecursiveRules()) {
            return;
        }

        if (!ruleAnalysis.hasBackwardRules()) {
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST,
                    "Recursive rules are only supported in playground for backward chaining. " +
                    "Rewrite the recursive rule as a backward rule and add explicit table(<predicate>) directives.");
        }

        if (!ruleAnalysis.allRecursivePredicatesTabled()) {
            throw new PlaygroundQueryException(HttpStatus.BAD_REQUEST,
                    "Recursive backward rules require explicit tabling in Jena. " +
                    "Add -> table(<predicate>). for each recursive predicate, or use tableAll(). " +
                    "Missing table directives for: " + String.join(", ", ruleAnalysis.untabledRecursivePredicates()));
        }
    }

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
}
