package com.unconcealment.backend.controller;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * Request body for POST /query/playground.
 * Both fields are plain strings sent as application/json.
 */
public record PlaygroundRequest(
        @Schema(
                description = "Reasoning rules in Jena rule syntax",
                example = "[r1: (?a <http://example/p> ?b) -> (?a <http://example/q> ?b)]"
        )
        String rules,
        @Schema(
                description = "SPARQL query to execute against the playground model",
                example = "SELECT * WHERE { ?s ?p ?o } LIMIT 25"
        )
        String query
) {}
