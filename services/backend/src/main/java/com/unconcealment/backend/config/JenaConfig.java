package com.unconcealment.backend.config;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.rdfconnection.RDFConnectionRemote;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Creates one RDFConnection per dataset defined in manifest.yaml.
 *
 * Each connection is built with explicit query, update, and GSP endpoints:
 *   - queryEndpoint  "sparql" → POST /query/raw, /query/reasoned, /query/tbox
 *   - updateEndpoint "update" → POST /query/update (SPARQL UPDATE)
 *   - gspEndpoint    "data"   → conn.load() uses HTTP PUT to load TTL models
 *
 * Using conn.load(graphUri, model) avoids the Fuseki LOAD <file://...> command,
 * which requires filesystem co-location between the backend and Fuseki containers.
 */
@Configuration
public class JenaConfig {

    private static final Logger log = LoggerFactory.getLogger(JenaConfig.class);

    @Value("${app.fuseki-url:http://localhost:3030}")
    private String fusekiUrl;

    /**
     * Returns a map of datasetId → RDFConnection.
     * Each connection targets the dataset's Fuseki endpoint with full query/update/GSP support.
     */
    @Bean
    public Map<String, RDFConnection> datasetConnections(DatasetManifest manifest) {
        Map<String, RDFConnection> connections = new LinkedHashMap<>();
        for (DatasetConfig dataset : manifest.getDatasets()) {
            String base = fusekiUrl + "/" + dataset.getFusekiDataset();
            log.info("Configuring RDFConnection for dataset '{}' at {}", dataset.getId(), base);
            RDFConnection conn = RDFConnectionRemote.newBuilder()
                    .destination(base)
                    .queryEndpoint("sparql")
                    .updateEndpoint("update")
                    .gspEndpoint("data")
                    .build();
            connections.put(dataset.getId(), conn);
        }
        return connections;
    }
}
