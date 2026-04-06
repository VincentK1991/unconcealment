package com.unconcealment.backend.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * SPARQL query gateway. All consumers (MCP tools, web UI, CLI) route through here.
 * Routes queries to either the InfModel (with reasoning) or raw TDB2,
 * depending on the endpoint called.
 *
 * All endpoints accept a `dataset` query parameter matching an id in manifest.yaml.
 * No dataset names are hardcoded.
 *
 * TODO (Phase 1): wire to JenaConfig.datasetConnections and implement routing logic.
 */
@RestController
@RequestMapping("/query")
public class QueryController {

    /**
     * POST /query/reasoned?dataset={id}
     * Executes SPARQL via the InfModel (backward chaining + owl:sameAs closure).
     * Use for: entity lookup, graph traversal, time travel queries.
     */
    @PostMapping("/reasoned")
    public ResponseEntity<Map<String, Object>> queryReasoned(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        // TODO: route to InfModel for the given dataset
        return ResponseEntity.ok(Map.of("status", "stub", "dataset", dataset));
    }

    /**
     * POST /query/raw?dataset={id}
     * Executes SPARQL directly against TDB2 (no inference).
     * Use for: provenance lookup, health graph queries, TBox browsing.
     */
    @PostMapping("/raw")
    public ResponseEntity<Map<String, Object>> queryRaw(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        // TODO: route to raw TDB2 connection for the given dataset
        return ResponseEntity.ok(Map.of("status", "stub", "dataset", dataset));
    }

    /**
     * POST /query/text?dataset={id}
     * Two-hop: Jena-text index → candidate IRIs → canonical resolution via InfModel.
     * Use for: full text search with owl:sameAs normalization.
     */
    @PostMapping("/text")
    public ResponseEntity<Map<String, Object>> queryText(
            @RequestParam String dataset,
            @RequestBody String searchText) {
        // TODO: hit Jena-text index, then resolve via InfModel
        return ResponseEntity.ok(Map.of("status", "stub", "dataset", dataset));
    }

    /**
     * POST /query/tbox?dataset={id}
     * Queries TBox named graphs only (ontology + rules introspection).
     * No inference applied.
     */
    @PostMapping("/tbox")
    public ResponseEntity<Map<String, Object>> queryTbox(
            @RequestParam String dataset,
            @RequestBody String sparql) {
        // TODO: restrict query to tbox named graphs for the given dataset
        return ResponseEntity.ok(Map.of("status", "stub", "dataset", dataset));
    }
}
