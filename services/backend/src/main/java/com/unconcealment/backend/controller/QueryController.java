package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.OntologyLoaderService;
import com.unconcealment.backend.service.OntopVkgService;
import com.unconcealment.backend.service.query.PlaygroundExecutionResult;
import com.unconcealment.backend.service.query.PlaygroundQueryException;
import com.unconcealment.backend.service.query.PlaygroundQueryService;
import com.unconcealment.backend.service.query.ReasoningAssetService;
import com.unconcealment.backend.service.query.SparqlQuerySupportService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
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
@Tag(name = "Query", description = "SPARQL query, update, reasoning, and VKG translation endpoints.")
public class QueryController {

    private static final Logger log = LoggerFactory.getLogger(QueryController.class);

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> datasetConnections;
    private final OntologyLoaderService ontologyLoader;
    private final ReasoningAssetService reasoningAssetService;
    private final SparqlQuerySupportService sparqlQuerySupportService;
    private final PlaygroundQueryService playgroundQueryService;
    private final OntopVkgService ontopVkgService;

    public QueryController(DatasetManifest manifest,
                           Map<String, RDFConnection> datasetConnections,
                           OntologyLoaderService ontologyLoader,
                           ReasoningAssetService reasoningAssetService,
                           SparqlQuerySupportService sparqlQuerySupportService,
                           PlaygroundQueryService playgroundQueryService,
                           OntopVkgService ontopVkgService) {
        this.manifest = manifest;
        this.datasetConnections = datasetConnections;
        this.ontologyLoader = ontologyLoader;
        this.reasoningAssetService = reasoningAssetService;
        this.sparqlQuerySupportService = sparqlQuerySupportService;
        this.playgroundQueryService = playgroundQueryService;
        this.ontopVkgService = ontopVkgService;
    }

    @PostMapping("/raw")
    @Operation(summary = "Run a raw SPARQL query against a dataset")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "SPARQL results in JSON"),
            @ApiResponse(responseCode = "400", description = "Invalid SPARQL"),
            @ApiResponse(responseCode = "404", description = "Unknown dataset")
    })
    public ResponseEntity<String> queryRaw(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "SPARQL query string",
                    content = @Content(
                            mediaType = "text/plain",
                            schema = @Schema(
                            type = "string",
                            example = "SELECT ?g ?s ?p ?o\nWHERE { GRAPH ?g { ?s ?p ?o } }\nLIMIT 20"
                    ))
            )
            @RequestBody String sparql) {
        return executeSparqlSelect(dataset, sparql, "raw");
    }

    @PostMapping("/tbox")
    @Operation(summary = "Run SPARQL query against dataset TBox graph")
    public ResponseEntity<String> queryTbox(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "SPARQL query string",
                    content = @Content(
                            mediaType = "text/plain",
                            schema = @Schema(
                            type = "string",
                            example = "SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> } LIMIT 20"
                    ))
            )
            @RequestBody String sparql) {
        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        NamedGraphs graphs = ds.namedGraphs();
        String tboxSparql = sparqlQuerySupportService.injectFromClauses(sparql, graphs.tbox());
        return executeSparqlSelect(dataset, tboxSparql, "tbox");
    }

    @PostMapping("/update")
    @Operation(summary = "Run SPARQL update against a dataset")
    public ResponseEntity<String> queryUpdate(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "SPARQL update statement",
                    content = @Content(
                            mediaType = "application/sparql-update",
                            schema = @Schema(
                            type = "string",
                            example = "INSERT DATA { <urn:test:s> <urn:test:p> <urn:test:o> . }"
                    ))
            )
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
    @Operation(summary = "Run SPARQL query against an in-memory reasoned model")
    public ResponseEntity<String> queryReasoned(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "SPARQL query string",
                    content = @Content(
                            mediaType = "text/plain",
                            schema = @Schema(
                            type = "string",
                            example = "SELECT * WHERE { ?s ?p ?o } LIMIT 20"
                    ))
            )
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
    @Operation(summary = "Run ad-hoc rules + query in the reasoning playground")
    public ResponseEntity<String> queryPlayground(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
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

    /**
     * Translates a SPARQL SELECT query to a PostgreSQL SQL string via Ontop VKG.
     *
     * The SQL is returned as-is — the caller is responsible for executing it
     * against the postgres-kg database (schema: acme_insurance).
     *
     * Accepts benchmark-style SPARQL with SERVICE :mapped { } wrappers;
     * they are stripped automatically before translation.
     *
     * Response: {"sql": "SELECT ..."}
     */
    @PostMapping("/vkg/translate")
    @Operation(summary = "Translate SPARQL SELECT to SQL via Ontop VKG")
    public ResponseEntity<String> translateVkg(
            @Parameter(description = "Dataset id from manifest.yaml", example = "insurance")
            @RequestParam String dataset,
            @Parameter(description = "When true, attempt to project SQL output to SPARQL answer variables only.")
            @RequestParam(defaultValue = "false") boolean projected,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "SPARQL SELECT query to translate",
                    content = @Content(
                            mediaType = "application/sparql-query",
                            schema = @Schema(
                            type = "string",
                            example = "SELECT ?policy WHERE { ?policy a <http://example/Policy> } LIMIT 10"
                    ))
            )
            @RequestBody String sparql) {
        if (!ontopVkgService.isAvailable(dataset)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":\"No VKG engine for dataset '" + dataset +
                          "'. Ensure postgres.enabled=true in manifest.yaml.\"}");
        }
        try {
            var result = ontopVkgService.translate(dataset, sparql, projected);
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"sql\":" + jsonString(result.sql()) +
                          ",\"projectedRequested\":" + projected +
                          ",\"projectedApplied\":" + result.projectedApplied() + "}");
        } catch (IllegalArgumentException e) {
            log.warn("[{}] [vkg/translate] Bad request: {}", dataset, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        } catch (Exception e) {
            log.error("[{}] [vkg/translate] Translation failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    @PostMapping("/text")
    @Operation(summary = "Full-text search over indexed labels/comments via Jena-text (Lucene)")
    public ResponseEntity<String> queryText(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @io.swagger.v3.oas.annotations.parameters.RequestBody(
                    required = true,
                    description = "Plain-text search phrase",
                    content = @Content(
                            mediaType = "text/plain",
                            schema = @Schema(type = "string", example = "chronic disease prevalence")
                    )
            )
            @RequestBody String searchText) {
        String term = searchText == null ? "" : searchText.trim();
        if (term.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":\"Search text must not be empty\"}");
        }
        String sparql = buildTextSearchSparql(term);
        return executeSparqlSelect(dataset, sparql, "text");
    }

    @PostMapping("/admin/reload")
    @Operation(summary = "Reload ontology and reasoning assets for a dataset")
    public ResponseEntity<String> adminReload(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset) {
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

    private String buildTextSearchSparql(String term) {
        String escaped = term.replace("\\", "\\\\").replace("\"", "\\\"");
        return """
                PREFIX text: <http://jena.apache.org/text#>
                PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

                SELECT DISTINCT ?s ?score ?label ?comment
                WHERE {
                  {
                    (?s ?score) text:query (rdfs:label "%s" 50) .
                  }
                  UNION
                  {
                    (?s ?score) text:query (rdfs:comment "%s" 50) .
                  }
                  OPTIONAL { ?s rdfs:label ?label }
                  OPTIONAL { ?s rdfs:comment ?comment }
                }
                ORDER BY DESC(?score)
                LIMIT 20
                """.formatted(escaped, escaped);
    }
}
