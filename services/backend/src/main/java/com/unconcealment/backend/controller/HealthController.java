package com.unconcealment.backend.controller;

import com.unconcealment.backend.model.DatasetManifest;
import org.apache.jena.rdfconnection.RDFConnection;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.util.*;

/**
 * Live infrastructure health endpoints.
 * These expose real-time signals for ops dashboards — they are NOT stored in the graph.
 * Durable operational facts (rule reload events, ontology version lineage) go to urn:system:health:{datasetId}.
 *
 * TODO (Phase 1): add triple counts per named graph, InfModel loaded status, rules count.
 */
@RestController
@RequestMapping("/health")
public class HealthController {

    private final DatasetManifest manifest;
    private final Map<String, RDFConnection> connections;

    public HealthController(DatasetManifest manifest, Map<String, RDFConnection> connections) {
        this.manifest = manifest;
        this.connections = connections;
    }

    /**
     * GET /health/live
     * JVM heap usage, uptime. Always returns 200 if JVM is alive.
     */
    @GetMapping("/live")
    public Map<String, Object> live() {
        MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
        long heapUsed = mem.getHeapMemoryUsage().getUsed();
        long heapMax  = mem.getHeapMemoryUsage().getMax();
        return Map.of(
            "status", "UP",
            "heapUsedMb", heapUsed / (1024 * 1024),
            "heapMaxMb",  heapMax  / (1024 * 1024),
            "uptimeMs", ManagementFactory.getRuntimeMXBean().getUptime()
        );
    }

    /**
     * GET /health/ready
     * Checks: Fuseki reachable for each dataset, InfModel loaded, rules count.
     * Returns 200 only when all datasets are ready.
     */
    @GetMapping("/ready")
    public Map<String, Object> ready() {
        List<Map<String, Object>> datasetStatus = new ArrayList<>();
        boolean allReady = true;

        for (DatasetManifest.DatasetConfig ds : manifest.getDatasets()) {
            boolean fusekiReachable = false;
            try {
                RDFConnection conn = connections.get(ds.getId());
                if (conn != null) {
                    // TODO: execute a lightweight ASK query to verify Fuseki is reachable
                    fusekiReachable = true;
                }
            } catch (Exception e) {
                allReady = false;
            }
            datasetStatus.add(Map.of(
                "id", ds.getId(),
                "fusekiReachable", fusekiReachable,
                "infModelLoaded", false, // TODO: track in JenaConfig
                "rulesCount", 0          // TODO: count from named graphs
            ));
        }

        return Map.of(
            "status", allReady ? "READY" : "NOT_READY",
            "datasets", datasetStatus
        );
    }

    /**
     * GET /health/metrics
     * Prometheus-compatible metrics. Spring Actuator + Micrometer handle most of this.
     * Custom metrics (triple counts, rule counts) will be added in Phase 1.
     */
    @GetMapping("/metrics")
    public Map<String, Object> metrics() {
        // TODO: expose triple counts per named graph via Micrometer gauges
        return Map.of(
            "note", "Use /actuator/prometheus for Prometheus-compatible metrics",
            "datasets", manifest.getDatasets().stream()
                .map(ds -> Map.of("id", ds.getId(), "tripleCount", -1))
                .toList()
        );
    }
}
