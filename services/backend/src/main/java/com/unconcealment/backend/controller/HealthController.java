package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.rdfconnection.RDFConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.util.*;

/**
 * Live infrastructure health endpoints.
 * These expose real-time signals for ops dashboards.
 * Durable operational facts (load events, ontology version lineage) are stored in urn:system:health:{datasetId}.
 */
@RestController
@RequestMapping("/health")
@Tag(name = "Health", description = "Runtime liveness, readiness, and metric summary endpoints.")
public class HealthController {

    private static final Logger log = LoggerFactory.getLogger(HealthController.class);

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> connections;

    public HealthController(DatasetManifest manifest, Map<String, RDFConnection> connections) {
        this.manifest = manifest;
        this.connections = connections;
    }

    /**
     * GET /health/live
     * JVM heap usage, uptime. Always returns 200 if the JVM is alive.
     */
    @GetMapping("/live")
    @Operation(summary = "JVM liveness check with heap and uptime metrics")
    public Map<String, Object> live() {
        MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
        long heapUsed = mem.getHeapMemoryUsage().getUsed();
        long heapMax  = mem.getHeapMemoryUsage().getMax();
        return Map.of(
            "status",    "UP",
            "heapUsedMb", heapUsed / (1024 * 1024),
            "heapMaxMb",  heapMax  / (1024 * 1024),
            "uptimeMs",   ManagementFactory.getRuntimeMXBean().getUptime()
        );
    }

    /**
     * GET /health/ready
     * Checks Fuseki reachability for each dataset via a lightweight ASK query.
     * Returns 200 only when all datasets are reachable.
     */
    @GetMapping("/ready")
    @Operation(summary = "Readiness check for all configured datasets against Fuseki")
    public Map<String, Object> ready() {
        List<Map<String, Object>> datasetStatus = new ArrayList<>();
        boolean allReady = true;

        for (DatasetManifest.DatasetConfig ds : manifest.getDatasets()) {
            boolean fusekiReachable = checkFusekiReachable(ds.getId());
            if (!fusekiReachable) allReady = false;

            datasetStatus.add(Map.of(
                "id",              ds.getId(),
                "fusekiReachable", fusekiReachable
            ));
        }

        return Map.of(
            "status",   allReady ? "READY" : "NOT_READY",
            "datasets", datasetStatus
        );
    }

    /**
     * GET /health/metrics
     * Basic triple count per dataset. Phase 4 adds per-named-graph breakdown
     * and Micrometer gauge registration.
     */
    @GetMapping("/metrics")
    @Operation(summary = "Triple-count metrics per dataset")
    public Map<String, Object> metrics() {
        List<Map<String, Object>> datasetMetrics = new ArrayList<>();

        for (DatasetManifest.DatasetConfig ds : manifest.getDatasets()) {
            long tripleCount = queryTripleCount(ds.getId());
            datasetMetrics.add(Map.of(
                "id",          ds.getId(),
                "tripleCount", tripleCount
            ));
        }

        return Map.of(
            "datasets", datasetMetrics,
            "note",     "Phase 4 adds per-named-graph counts and Prometheus gauges"
        );
    }

    // -------------------------------------------------------------------------

    private boolean checkFusekiReachable(String datasetId) {
        RDFConnection conn = connections.get(datasetId);
        if (conn == null) return false;
        try (QueryExecution qExec = conn.query("ASK { ?s ?p ?o }")) {
            qExec.execAsk();
            return true;
        } catch (Exception e) {
            log.warn("[{}] Fuseki not reachable: {}", datasetId, e.getMessage());
            return false;
        }
    }

    private long queryTripleCount(String datasetId) {
        RDFConnection conn = connections.get(datasetId);
        if (conn == null) return -1;
        try (QueryExecution qExec = conn.query("SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }")) {
            var rs = qExec.execSelect();
            if (rs.hasNext()) {
                return rs.next().getLiteral("count").getLong();
            }
            return 0;
        } catch (Exception e) {
            log.warn("[{}] Triple count query failed: {}", datasetId, e.getMessage());
            return -1;
        }
    }
}
