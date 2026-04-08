package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.OntologyLoaderService;
import com.unconcealment.backend.service.query.PlaygroundExecutionResult;
import com.unconcealment.backend.service.query.PlaygroundQueryException;
import com.unconcealment.backend.service.query.PlaygroundQueryService;
import com.unconcealment.backend.service.query.ReasoningAssetService;
import com.unconcealment.backend.service.query.SparqlQuerySupportService;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryFactory;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * SPARQL query and update gateway. All consumers (web UI, MCP tools, CLI) route through here.
 * Never exposes Fuseki directly — all queries go through this controller.
 */
@RestController
@RequestMapping("/query")
public class QueryController {

    private static final Logger log = LoggerFactory.getLogger(QueryController.class);

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> datasetConnections;
    private final OntologyLoaderService ontologyLoader;
    private final ReasoningAssetService reasoningAssetService;
    private final SparqlQuerySupportService sparqlQuerySupportService;
    private final PlaygroundQueryService playgroundQueryService;

    public QueryController(DatasetManifest manifest,
                           Map<String, RDFConnection> datasetConnections,
                           OntologyLoaderService ontologyLoader,
                           ReasoningAssetService reasoningAssetService,
                           SparqlQuerySupportService sparqlQuerySupportService,
                           PlaygroundQueryService playgroundQueryService) {
        this.manifest = manifest;
        this.datasetConnections = datasetConnections;
        this.ontologyLoader = ontologyLoader;
        this.reasoningAssetService = reasoningAssetService;
        this.sparqlQuerySupportService = sparqlQuerySupportService;
        this.playgroundQueryService = playgroundQueryService;
    }

    @PostMapping("/raw")
    public ResponseEntity<String> queryRaw(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        return executeSparqlSelect(dataset, sparql, "raw");
    }

    @PostMapping("/tbox")
    public ResponseEntity<String> queryTbox(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        NamedGraphs graphs = ds.namedGraphs();
        String tboxSparql = sparqlQuerySupportService.injectFromClauses(
                sparql, graphs.tbox(), graphs.rulesForward(), graphs.rulesBackward());
        return executeSparqlSelect(dataset, tboxSparql, "tbox");
    }

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

    /**
     * Executes SPARQL against an in-memory InfModel built from normalization-only data.
     * This route intentionally avoids loading the asserted ABox because HYBRID mode on the full
     * graph was previously causing broad backward expansion and OOM.
     */
    @PostMapping("/reasoned")
    public ResponseEntity<String> queryReasoned(
            @RequestParam String dataset,
            @RequestBody String sparql) {

        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        RDFConnection conn = datasetConnections.get(dataset);
        NamedGraphs graphs = ds.namedGraphs();

        try {
            Model normModel = reasoningAssetService.loadGraphIriTriples(conn, graphs.normalization());

            List<Rule> rules = new ArrayList<>();
            rules.addAll(reasoningAssetService.loadRules(conn, graphs.rulesForward(), "ForwardRule", 30));
            rules.addAll(reasoningAssetService.loadRules(conn, graphs.rulesBackward(), "BackwardRule", Integer.MAX_VALUE));

            GenericRuleReasoner reasoner = new GenericRuleReasoner(rules);
            reasoner.setMode(GenericRuleReasoner.HYBRID);

            InfModel infModel = ModelFactory.createInfModel(reasoner, normModel);
            Query query = QueryFactory.create(sparql);

            try {
                String json = sparqlQuerySupportService.executeModelSelectAsJson(query, infModel, 0);
                return ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType("application/sparql-results+json"))
                        .body(json);
            } finally {
                infModel.close();
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

    @PostMapping(value = "/playground", consumes = "application/json")
    public ResponseEntity<String> queryPlayground(
            @RequestParam String dataset,
            @RequestBody PlaygroundRequest req) {

        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);

        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        try {
            PlaygroundExecutionResult result = playgroundQueryService.execute(dataset, conn, ds.namedGraphs(), req);
            String body = "{\"queryResults\":" + result.queryResultsJson() + ",\"baseResults\":" + result.baseResultsJson() + "}";
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
        } catch (PlaygroundQueryException e) {
            return ResponseEntity.status(e.status())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    @PostMapping("/text")
    public ResponseEntity<String> queryText(
            @RequestParam String dataset,
            @RequestBody String searchText) {
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                .contentType(MediaType.APPLICATION_JSON)
                .body("{\"error\":\"text search not yet implemented (Phase 3)\"}");
    }

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

    private ResponseEntity<String> executeSparqlSelect(String dataset, String sparql, String routeLabel) {
        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);
        try {
            Query query = QueryFactory.create(sparql);
            String json = sparqlQuerySupportService.executeConnectionSelectAsJson(conn, query);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("application/sparql-results+json"))
                    .body(json);
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

    private String jsonString(String value) {
        if (value == null) return "null";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }
}
