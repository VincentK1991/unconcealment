package com.unconcealment.backend.config;

import com.unconcealment.backend.model.DatasetManifest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.Constructor;
import org.yaml.snakeyaml.LoaderOptions;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Loads ontology/manifest.yaml at startup and exposes the parsed
 * DatasetManifest as a Spring bean. All other components consume
 * this bean — no dataset names or named graph URIs are hardcoded
 * anywhere else in the application.
 */
@Configuration
public class ManifestLoader {

    @Value("${app.manifest-path:ontology/manifest.yaml}")
    private String manifestPath;

    @Bean
    public DatasetManifest datasetManifest() throws IOException {
        LoaderOptions options = new LoaderOptions();
        Yaml yaml = new Yaml(new Constructor(DatasetManifest.class, options));
        try (InputStream in = new FileInputStream(manifestPath)) {
            return yaml.load(in);
        }
    }
}
