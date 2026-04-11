package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import com.unconcealment.backend.service.MaterializationService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;
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

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Ingest gateway: accepts LLM extraction payloads and writes RDF triples to the graph.
 *
 * The TypeScript indexing pipeline sends lightweight semantic output (entity labels,
 * ontology local names, integer indices) and this controller handles:
 *   - Deterministic UUID minting from dataset + slugified label for canonical entity IRIs
 *   - Resolving ontology local names → full IRIs via TBox SPARQL lookup
 *   - Building and executing RDF-star SPARQL INSERT DATA via Apache Jena
 *
 * Routes:
 *   POST /ingest/assertions?dataset={id}  → assert extracted entities + relationships
 */
@RestController
@RequestMapping("/ingest")
@Tag(name = "Ingest", description = "Entity assertion and normalization materialization endpoints.")
public class IngestController {

    private static final Logger log = LoggerFactory.getLogger(IngestController.class);

    private static final String ONTOLOGY_NS = "http://localhost:4321/ontology/";

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> datasetConnections;
    private final MaterializationService materializationService;

    public IngestController(DatasetManifest manifest,
                            Map<String, RDFConnection> datasetConnections,
                            MaterializationService materializationService) {
        this.manifest = manifest;
        this.datasetConnections = datasetConnections;
        this.materializationService = materializationService;
    }

    // -------------------------------------------------------------------------
    // DTOs
    // -------------------------------------------------------------------------

    public static class AttributeDto {
        @Schema(description = "Predicate local name or full IRI", example = "hasPolicyNumber")
        public String predicate;
        @Schema(description = "Literal value for this attribute", example = "POL-12345")
        public String value;
    }

    public static class EntityDto {
        @Schema(description = "Human-readable entity label", example = "Acme Insurance")
        public String label;
        @Schema(description = "Entity type local name or full IRI", example = "Insurer")
        public String type;
        @Schema(description = "Optional free-text description", example = "Regional health insurer in NY")
        public String description;
        @Schema(description = "Optional scalar attributes for this entity")
        public List<AttributeDto> attributes;
    }

    public static class RelationshipDto {
        @Schema(description = "Index of subject entity in entities[]", example = "0")
        public int subjectId;
        @Schema(description = "Predicate local name or full IRI", example = "offersPlan")
        public String predicate;
        @Schema(description = "Index of object entity in entities[] when objectIsLiteral=false", example = "1")
        public Integer objectId;       // null when objectIsLiteral is true
        @Schema(description = "Object literal value when objectIsLiteral=true", example = "Gold PPO 500")
        public String objectLiteral;   // null when objectIsLiteral is false
        @Schema(description = "True when objectLiteral should be used as object", example = "false")
        public boolean objectIsLiteral;
        @Schema(description = "Extraction confidence score [0.0, 1.0]", example = "0.92")
        public double confidence;
    }

    public static class AssertionRequest {
        @Schema(description = "Source document IRI", example = "urn:doc:acme/2026-q1-report")
        public String documentIri;
        @Schema(description = "Indexing run id for traceability", example = "run-2026-04-10-001")
        public String indexingRunId;
        @Schema(description = "Extraction method identifier", example = "llm-gpt5")
        public String extractionMethod;
        @Schema(description = "Extraction timestamp in ISO-8601 format", example = "2026-04-10T12:00:00Z")
        public String extractedAt;
        @Schema(description = "Entities extracted from the document")
        public List<EntityDto> entities;
        @Schema(description = "Relationships extracted from the document")
        public List<RelationshipDto> relationships;
    }

    // -------------------------------------------------------------------------
    // POST /ingest/assertions
    // -------------------------------------------------------------------------

    /**
     * Accepts the LLM extraction payload and writes entity type triples + relationship
     * triples (with RDF-star provenance) into the dataset's abox:asserted named graph.
     *
     * Each relationship triple is annotated with:
     *   ex:sourceDocument, ex:extractedAt, ex:confidence, ex:extractionMethod,
     *   ex:indexingRun, ex:transactionTime
     *
     * Entity IRIs are minted deterministically: {baseUri}/entity/{uuid}
     * A slug is still asserted as metadata (ex:slug) for human-readable aliases.
     * Ontology IRIs are resolved by local name lookup against the TBox named graph.
     */
    @PostMapping("/assertions")
    @Operation(summary = "Assert extracted entities and relationships as RDF triples")
    public ResponseEntity<String> assertEntities(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset,
            @RequestBody AssertionRequest request) {

        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);

        if (request.entities == null || request.entities.isEmpty()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"ok\",\"triplesAsserted\":0}");
        }

        // Resolve ontology local names → full IRIs from the loaded TBox
        Map<String, String> localNameToIri = buildLocalNameMap(conn, ds.namedGraphs().tbox());

        // Mint canonical entity IRIs: {baseUri}/entity/{uuid}
        String[] entityIris = new String[request.entities.size()];
        for (int i = 0; i < request.entities.size(); i++) {
            EntityDto entity = request.entities.get(i);
            String canonicalEntityId = canonicalEntityId(dataset, entity);
            entityIris[i] = manifest.mintIri(ds, "aboxSegment", canonicalEntityId);
        }

        String now = Instant.now().toString();
        NamedGraphs graphs = ds.namedGraphs();

        StringBuilder triples = new StringBuilder();

        // --- Entity type + slug assertions ---
        for (int i = 0; i < request.entities.size(); i++) {
            EntityDto entity = request.entities.get(i);
            String entityIri = entityIris[i];
            String slug = slugify(entity.label);

            // rdfs:label — human-readable label; indexed by Jena-text (Lucene) for full-text search
            triples.append("    <").append(entityIri).append("> ")
                   .append("<http://www.w3.org/2000/01/rdf-schema#label> ")
                   .append("\"").append(escapeSparqlLiteral(entity.label)).append("\" .\n");

            // ex:slug — used by the web server's slug → IRI lookup
            triples.append("    <").append(entityIri).append("> ")
                   .append("<").append(ONTOLOGY_NS).append("slug> ")
                   .append("\"").append(escapeSparqlLiteral(slug)).append("\" .\n");

            String typeIri = resolveOntologyIri(entity.type, localNameToIri);
            if (!localNameToIri.containsKey(entity.type)) {
                log.info("[{}] Unknown entity type local name '{}' for entity '{}' — minting IRI <{}> (open-world)",
                        dataset, entity.type, entity.label, typeIri);
            }
            String typeS = "<" + entityIri + ">";
            String typeP = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>";
            String typeO = "<" + typeIri + ">";
            triples.append("    ").append(typeS).append(" ").append(typeP).append(" ").append(typeO).append(" .\n");
            triples.append("    << ").append(typeS).append(" ").append(typeP).append(" ").append(typeO).append(" >>\n")
                   .append("      <").append(ONTOLOGY_NS).append("sourceDocument>   <").append(request.documentIri).append("> ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("extractedAt>      \"").append(escapeSparqlLiteral(request.extractedAt)).append("\"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("extractionMethod> \"").append(escapeSparqlLiteral(request.extractionMethod)).append("\" ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("indexingRun>      \"").append(escapeSparqlLiteral(request.indexingRunId)).append("\" ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("transactionTime>  \"").append(escapeSparqlLiteral(now)).append("\"^^<http://www.w3.org/2001/XMLSchema#dateTime> .\n\n");

            // rdfs:comment (description)
            if (entity.description != null && !entity.description.isBlank()) {
                triples.append("    <").append(entityIri).append("> ")
                       .append("<http://www.w3.org/2000/01/rdf-schema#comment> ")
                       .append("\"").append(escapeSparqlLiteral(entity.description)).append("\" .\n");
            }

            // entity-level scalar attributes
            if (entity.attributes != null) {
                for (AttributeDto attr : entity.attributes) {
                    if (attr.predicate == null || attr.value == null) continue;
                    String predicateIri = resolveOntologyIri(attr.predicate, localNameToIri);
                    triples.append("    <").append(entityIri).append("> ")
                           .append("<").append(predicateIri).append("> ")
                           .append("\"").append(escapeSparqlLiteral(attr.value)).append("\" .\n");
                }
            }
        }

        // --- Relationship triples with RDF-star provenance ---
        int triplesAsserted = 0;
        for (RelationshipDto rel : request.relationships) {
            if (rel.subjectId < 0 || rel.subjectId >= entityIris.length) {
                log.warn("[{}] Skipping relationship with out-of-range subjectId={}", dataset, rel.subjectId);
                continue;
            }

            String subjectIri = entityIris[rel.subjectId];
            String predicateIri = resolveOntologyIri(rel.predicate, localNameToIri);
            if (!localNameToIri.containsKey(rel.predicate)) {
                log.info("[{}] Unknown predicate local name '{}' — minting IRI <{}> (open-world)", dataset, rel.predicate, predicateIri);
            }

            String objectTerm;
            if (rel.objectIsLiteral) {
                objectTerm = "\"" + escapeSparqlLiteral(rel.objectLiteral) + "\"";
            } else {
                if (rel.objectId == null || rel.objectId < 0 || rel.objectId >= entityIris.length) {
                    log.warn("[{}] Skipping relationship with out-of-range objectId={}", dataset, rel.objectId);
                    continue;
                }
                objectTerm = "<" + entityIris[rel.objectId] + ">";
            }

            String s = "<" + subjectIri + ">";
            String p = "<" + predicateIri + ">";
            String o = objectTerm;

            // Base triple
            triples.append("    ").append(s).append(" ").append(p).append(" ").append(o).append(" .\n");

            // RDF-star annotation
            triples.append("    << ").append(s).append(" ").append(p).append(" ").append(o).append(" >>\n")
                   .append("      <").append(ONTOLOGY_NS).append("sourceDocument>   <").append(request.documentIri).append("> ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("extractedAt>      \"").append(escapeSparqlLiteral(request.extractedAt)).append("\"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("confidence>       ").append(rel.confidence).append(" ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("extractionMethod> \"").append(escapeSparqlLiteral(request.extractionMethod)).append("\" ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("indexingRun>      \"").append(escapeSparqlLiteral(request.indexingRunId)).append("\" ;\n")
                   .append("      <").append(ONTOLOGY_NS).append("transactionTime>  \"").append(escapeSparqlLiteral(now)).append("\"^^<http://www.w3.org/2001/XMLSchema#dateTime> .\n\n");

            triplesAsserted++;
        }

        if (triplesAsserted == 0 && triples.isEmpty()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"ok\",\"triplesAsserted\":0}");
        }

        String sparql = """
                PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
                PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

                INSERT DATA {
                  GRAPH <%s> {
                %s  }
                }
                """.formatted(graphs.aboxAsserted(), triples);

        try {
            conn.update(UpdateFactory.create(sparql));
            log.info("[{}] Asserted {} relationship triple(s) + {} entity type(s) from document <{}>",
                    dataset, triplesAsserted, request.entities.size(), request.documentIri);
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"ok\",\"triplesAsserted\":" + triplesAsserted + "}");
        } catch (Exception e) {
            log.error("[{}] SPARQL INSERT failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    // -------------------------------------------------------------------------
    // POST /ingest/normalize
    // -------------------------------------------------------------------------

    /**
     * Triggers sameAs materialization for the given dataset using Jena's forward-chaining
     * rule engine. Loads the normalization graph + abox:asserted, applies the four hardcoded
     * sameAs rules (symmetry, transitivity, prop-fwd, prop-bwd), and writes the deduced
     * triples to abox:inferred (replacing any previous content).
     *
     * Called by the TypeScript indexing pipeline after both normalization steps complete.
     * Safe to call multiple times — abox:inferred is fully replaced on each invocation.
     */
    @PostMapping("/normalize")
    @Operation(summary = "Materialize owl:sameAs deductions into inferred graph")
    public ResponseEntity<String> normalize(
            @Parameter(description = "Dataset id from manifest.yaml", example = "economic-census")
            @RequestParam String dataset) {
        DatasetConfig ds = resolveDataset(dataset);
        if (ds == null) return datasetNotFound(dataset);

        RDFConnection conn = datasetConnections.get(dataset);
        if (conn == null) return datasetNotFound(dataset);

        try {
            long deductionTriples = materializationService.materializeSameAs(dataset, conn, ds.namedGraphs());
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"status\":\"ok\",\"deductionTriples\":" + deductionTriples + "}");
        } catch (Exception e) {
            log.error("[{}] sameAs materialization failed: {}", dataset, e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":" + jsonString(e.getMessage()) + "}");
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Queries the TBox named graph to build a map of ontology local name → full IRI.
     * Covers owl:Class, owl:ObjectProperty, and owl:DatatypeProperty.
     * Falls back to an empty map if the query fails (non-fatal).
     */
    private Map<String, String> buildLocalNameMap(RDFConnection conn, String tboxGraphUri) {
        Map<String, String> map = new HashMap<>();
        String sparql = """
                PREFIX owl: <http://www.w3.org/2002/07/owl#>
                SELECT ?iri WHERE {
                  GRAPH <%s> {
                    { ?iri a owl:Class }
                    UNION { ?iri a owl:ObjectProperty }
                    UNION { ?iri a owl:DatatypeProperty }
                    FILTER(isIRI(?iri))
                  }
                }
                """.formatted(tboxGraphUri);
        try {
            Query q = QueryFactory.create(sparql);
            try (QueryExecution qe = conn.query(q)) {
                ResultSet rs = qe.execSelect();
                while (rs.hasNext()) {
                    QuerySolution row = rs.nextSolution();
                    String iri = row.getResource("iri").getURI();
                    String localName = extractLocalName(iri);
                    map.put(localName, iri);
                }
            }
        } catch (Exception e) {
            log.warn("Could not build local name map from TBox <{}>: {}", tboxGraphUri, e.getMessage());
        }
        return map;
    }

    /** Extracts the local name from a full IRI (after the last '#' or '/'). */
    private String extractLocalName(String iri) {
        int hash = iri.lastIndexOf('#');
        int slash = iri.lastIndexOf('/');
        int idx = Math.max(hash, slash);
        return idx >= 0 ? iri.substring(idx + 1) : iri;
    }

    /**
     * Produces a URL-safe slug from a human-readable label.
     * Deterministic: same label always yields the same slug.
     * Example: "Apple Inc." → "apple-inc"
     */
    private String slugify(String label) {
        if (label == null) return "";
        return label.toLowerCase()
                    .replaceAll("[^a-z0-9]+", "-")
                    .replaceAll("(^-|-$)", "");
    }

    /**
     * Produces a dataset-scoped, human-readable entity path segment of the form
     * "{datasetId}/{slug}-{shortHash}" where shortHash is the first 8 hex chars of
     * a UUID v3 seeded on "dataset:type:slug". This is both readable and collision-safe.
     *
     * mintIri appends this after the aboxSegment ("entity"), yielding:
     *   {baseUri}/entity/{datasetId}/{slug}-{shortHash}
     */
    private String canonicalEntityId(String datasetId, EntityDto entity) {
        String label = entity != null && entity.label != null ? entity.label : "";
        String type  = entity != null && entity.type  != null ? entity.type  : "";
        String slug  = slugify(label);
        String seed  = datasetId + ":" + type + ":" + slug;
        String uuid  = UUID.nameUUIDFromBytes(seed.getBytes(StandardCharsets.UTF_8)).toString();
        String hash  = uuid.replace("-", "").substring(0, 8);
        return datasetId + "/" + slug + "-" + hash;
    }

    /**
     * Resolves a local ontology term to a known IRI, or mints a safe fallback IRI in the ontology namespace.
     * This keeps ingestion open-world: unknown model terms are preserved rather than rejected.
     */
    private String resolveOntologyIri(String localName, Map<String, String> localNameToIri) {
        if (localName == null || localName.isBlank()) {
            return ONTOLOGY_NS + "unknown";
        }
        String known = localNameToIri.get(localName);
        if (known != null) return known;
        return ONTOLOGY_NS + sanitizeLocalName(localName);
    }

    /**
     * Produces a conservative local name that is safe to append to an ontology namespace.
     * Keeps alphanumerics, underscore, and hyphen; collapses other runs to a single hyphen.
     */
    private String sanitizeLocalName(String raw) {
        String safe = raw.trim()
                .replaceAll("[^A-Za-z0-9_-]+", "-")
                .replaceAll("(^-|-$)", "");
        return safe.isEmpty() ? "unknown" : safe;
    }

    /** Escapes special characters in a string for safe embedding in a SPARQL literal. */
    private String escapeSparqlLiteral(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r");
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
