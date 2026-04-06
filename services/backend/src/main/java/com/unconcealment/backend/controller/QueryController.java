package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.OntologyLoaderService;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.rdfconnection.RDFConnection;
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
import java.util.Map;

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
     * Executes SPARQL via the InfModel (backward chaining + owl:sameAs closure).
     * Phase 1: delegates to queryRaw. Phase 2: replaced with GenericRuleReasoner InfModel.
     */
    @PostMapping("/reasoned")
    public ResponseEntity<String> queryReasoned(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        // Phase 2: replace this with ReasonerService.executeReasoned(dataset, sparql)
        return executeSparqlSelect(dataset, sparql, "reasoned→raw");
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
