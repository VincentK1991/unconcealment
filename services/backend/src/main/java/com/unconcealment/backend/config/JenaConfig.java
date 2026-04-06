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
 * Configures one RDFConnection per dataset defined in manifest.yaml.
 * At startup, for each dataset:
 *   1. Opens a remote connection to the Fuseki dataset endpoint
 *   2. Loads the ontology TTL into the tbox named graph (TODO: Phase 1 impl)
 *   3. Loads forward + backward rules into their respective named graphs (TODO: Phase 1 impl)
 *   4. Builds a GenericRuleReasoner in HYBRID mode (TODO: Phase 1 impl)
 *
 * All dataset IDs and named graph URIs come from the manifest — nothing is hardcoded here.
 */
@Configuration
public class JenaConfig {

    private static final Logger log = LoggerFactory.getLogger(JenaConfig.class);

    @Value("${app.fuseki-url:http://localhost:3030}")
    private String fusekiUrl;

    /**
     * Returns a map of datasetId → RDFConnection to the Fuseki SPARQL endpoint.
     * Key is the dataset id from manifest.yaml (e.g. "economic-census").
     */
    @Bean
    public Map<String, RDFConnection> datasetConnections(DatasetManifest manifest) {
        Map<String, RDFConnection> connections = new LinkedHashMap<>();
        for (DatasetConfig dataset : manifest.getDatasets()) {
            String endpoint = fusekiUrl + "/" + dataset.getFusekiDataset() + "/sparql";
            log.info("Connecting to Fuseki dataset '{}' at {}", dataset.getId(), endpoint);
            RDFConnection conn = RDFConnectionRemote.service(endpoint).build();
            connections.put(dataset.getId(), conn);
        }
        return connections;
    }
}
