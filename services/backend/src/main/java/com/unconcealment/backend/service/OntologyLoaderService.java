package com.unconcealment.backend.service;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.riot.RDFDataMgr;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;

/**
 * Loads TTL ontology and rules files into Fuseki named graphs at startup and on reload.
 *
 * For each dataset in the manifest, loads:
 *   ontologyPath        → urn:{datasetId}:tbox:ontology
 *   rules.forward       → urn:{datasetId}:tbox:rules:forward
 *   rules.backward      → urn:{datasetId}:tbox:rules:backward
 *
 * Uses RDFDataMgr.loadModel(path) in the backend JVM, then conn.load(graphUri, model)
 * which does HTTP PUT to Fuseki's graph store protocol endpoint (/data?graph=...).
 * This avoids the Fuseki LOAD <file://...> command which requires filesystem co-location.
 *
 * Called at startup via AppStartup, and on-demand via POST /admin/reload.
 */
@Service
public class OntologyLoaderService {

    private static final Logger log = LoggerFactory.getLogger(OntologyLoaderService.class);

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> datasetConnections;

    public OntologyLoaderService(DatasetManifest manifest, Map<String, RDFConnection> datasetConnections) {
        this.manifest = manifest;
        this.datasetConnections = datasetConnections;
    }

    /** Load all datasets defined in the manifest. Called at startup. */
    public void loadAll() {
        for (DatasetConfig dataset : manifest.getDatasets()) {
            loadDataset(dataset.getId());
        }
    }

    /**
     * Load (or reload) a single dataset's ontology, forward rules, and backward rules
     * into their respective named graphs. Safe to call multiple times — each call
     * replaces the named graph contents via HTTP PUT (idempotent).
     */
    public void loadDataset(String datasetId) {
        DatasetConfig dataset = manifest.getDatasets().stream()
                .filter(d -> d.getId().equals(datasetId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown dataset: " + datasetId));

        RDFConnection conn = datasetConnections.get(datasetId);
        if (conn == null) {
            throw new IllegalStateException("No RDFConnection for dataset: " + datasetId);
        }

        NamedGraphs graphs = dataset.namedGraphs();

        loadTtl(conn, dataset.getOntologyPath(), graphs.tbox(), "ontology", datasetId);

        if (dataset.getRules() != null) {
            if (dataset.getRules().getForward() != null) {
                loadTtl(conn, dataset.getRules().getForward(), graphs.rulesForward(), "forward rules", datasetId);
            }
            if (dataset.getRules().getBackward() != null) {
                loadTtl(conn, dataset.getRules().getBackward(), graphs.rulesBackward(), "backward rules", datasetId);
            }
        }

        // Load R2RML Turtle bindings into urn:{datasetId}:bindings (new format).
        // Datasets using the legacy YAML format (bigquery.bindingsPath) are handled by the
        // TypeScript indexing pipeline; they do not produce a bindings named graph.
        if (dataset.getBindingsPath() != null) {
            loadTtl(conn, dataset.getBindingsPath(), graphs.bindings(), "bindings", datasetId);
        }

        recordLoadEvent(conn, graphs.systemHealth(), datasetId);
    }

    private void loadTtl(RDFConnection conn, String path, String graphUri, String role, String datasetId) {
        try {
            Model model = RDFDataMgr.loadModel(path);
            conn.load(graphUri, model);
            log.info("[{}] Loaded {} ({} triples) into <{}>", datasetId, role, model.size(), graphUri);
        } catch (Exception e) {
            log.error("[{}] Failed to load {} from '{}': {}", datasetId, role, path, e.getMessage(), e);
            throw new RuntimeException(
                    "Ontology load failed for dataset='" + datasetId + "' role='" + role + "' path='" + path + "'", e);
        }
    }

    private void recordLoadEvent(RDFConnection conn, String healthGraph, String datasetId) {
        String now = Instant.now().toString();
        String sparql = """
                PREFIX ex:  <http://localhost:4321/ontology/>
                PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
                INSERT DATA {
                  GRAPH <%s> {
                    [] a ex:OntologyLoadEvent ;
                       ex:datasetId "%s"^^xsd:string ;
                       ex:loadedAt  "%s"^^xsd:dateTime .
                  }
                }
                """.formatted(healthGraph, datasetId, now);
        try {
            conn.update(sparql);
        } catch (Exception e) {
            // Non-fatal: health event logging should not block startup
            log.warn("[{}] Could not write load event to health graph: {}", datasetId, e.getMessage());
        }
    }
}
