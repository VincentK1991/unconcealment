package com.unconcealment.backend.config;

import com.unconcealment.backend.service.OntologyLoaderService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Triggers ontology loading after the full Spring context is ready.
 * Runs after all beans (including JenaConfig, OntologyLoaderService) are wired.
 */
@Component
public class AppStartup implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AppStartup.class);

    private final OntologyLoaderService ontologyLoader;

    public AppStartup(OntologyLoaderService ontologyLoader) {
        this.ontologyLoader = ontologyLoader;
    }

    @Override
    public void run(ApplicationArguments args) {
        log.info("Loading ontologies and rules into Fuseki named graphs...");
        ontologyLoader.loadAll();
        log.info("Ontology load complete.");
    }
}
