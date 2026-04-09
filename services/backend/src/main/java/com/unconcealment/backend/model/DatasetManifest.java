package com.unconcealment.backend.model;

import java.util.List;

/**
 * Java representation of ontology/manifest.yaml.
 * The backend reads this at startup to configure Fuseki datasets,
 * load ontology TTL files, and build rule-based reasoners.
 * No dataset IDs, named graph URIs, base URIs, or domain vocabulary are hardcoded.
 */
public class DatasetManifest {

    /** Global base URI for IRI minting. Used by all datasets unless overridden per dataset. */
    private String baseUri;

    private List<DatasetConfig> datasets;

    /**
     * IRI segment labels, read from manifest.iriMinting.
     * Keys are segment identifiers (e.g. "tboxSegment", "aboxSegment");
     * values are the URL path segments used when minting IRIs.
     */
    private java.util.Map<String, String> iriMinting;

    public String getBaseUri() { return baseUri; }
    public void setBaseUri(String baseUri) { this.baseUri = baseUri; }

    public List<DatasetConfig> getDatasets() { return datasets; }
    public void setDatasets(List<DatasetConfig> datasets) { this.datasets = datasets; }

    public java.util.Map<String, String> getIriMinting() { return iriMinting; }
    public void setIriMinting(java.util.Map<String, String> iriMinting) { this.iriMinting = iriMinting; }

    /**
     * Resolves the effective base URI for a dataset.
     * Dataset-level baseUri takes precedence over the manifest-level default.
     */
    public String resolveBaseUri(DatasetConfig dataset) {
        return dataset.getBaseUri() != null ? dataset.getBaseUri() : this.baseUri;
    }

    /**
     * Mints a stable IRI using a segment key looked up from manifest.iriMinting.
     * Pattern: {baseUri}/{segment}/{uuid}
     */
    public String mintIri(DatasetConfig dataset, String segmentKey, String uuid) {
        String segment = iriMinting.get(segmentKey);
        if (segment == null) {
            throw new IllegalArgumentException(
                "Unknown IRI segment key '" + segmentKey + "'. " +
                "Available keys in manifest.iriMinting: " + iriMinting.keySet()
            );
        }
        return resolveBaseUri(dataset) + "/" + segment + "/" + uuid;
    }

    // -------------------------------------------------------------------------
    // Inner classes
    // -------------------------------------------------------------------------

    public static class DatasetConfig {
        private String id;
        private String label;
        private String description;
        /** Optional per-dataset base URI override. Falls back to manifest-level baseUri. */
        private String baseUri;
        private String ontologyPath;
        private RulesPaths rules;
        private String fusekiDataset;
        /**
         * Path to an R2RML Turtle bindings file (new format, per docs/decisions/semantic-binding.md).
         * When set, the backend loads this file into urn:{datasetId}:bindings at startup.
         * Takes precedence over bigquery.bindingsPath (legacy YAML format).
         */
        private String bindingsPath;
        private BigQueryConfig bigquery;
        private PostgresConfig postgres;

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }

        public String getLabel() { return label; }
        public void setLabel(String label) { this.label = label; }

        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }

        public String getBaseUri() { return baseUri; }
        public void setBaseUri(String baseUri) { this.baseUri = baseUri; }

        public String getOntologyPath() { return ontologyPath; }
        public void setOntologyPath(String ontologyPath) { this.ontologyPath = ontologyPath; }

        public RulesPaths getRules() { return rules; }
        public void setRules(RulesPaths rules) { this.rules = rules; }

        public String getFusekiDataset() { return fusekiDataset; }
        public void setFusekiDataset(String fusekiDataset) { this.fusekiDataset = fusekiDataset; }

        public String getBindingsPath() { return bindingsPath; }
        public void setBindingsPath(String bindingsPath) { this.bindingsPath = bindingsPath; }

        public BigQueryConfig getBigquery() { return bigquery; }
        public void setBigquery(BigQueryConfig bigquery) { this.bigquery = bigquery; }

        public PostgresConfig getPostgres() { return postgres; }
        public void setPostgres(PostgresConfig postgres) { this.postgres = postgres; }

        /** Returns named graph URIs derived from the dataset id. */
        public NamedGraphs namedGraphs() {
            return new NamedGraphs(id);
        }
    }

    public static class RulesPaths {
        private String forward;
        private String backward;

        public String getForward() { return forward; }
        public void setForward(String forward) { this.forward = forward; }
        public String getBackward() { return backward; }
        public void setBackward(String backward) { this.backward = backward; }
    }

    public static class BigQueryConfig {
        private boolean enabled;
        /** Legacy YAML bindings path. Used by economic-census and public-health datasets. */
        private String bindingsPath;
        /** GCP project ID. Replaces any hardcoded project references in SQL templates. */
        private String project;
        /** BigQuery dataset name within the GCP project. */
        private String dataset;

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getBindingsPath() { return bindingsPath; }
        public void setBindingsPath(String bindingsPath) { this.bindingsPath = bindingsPath; }
        public String getProject() { return project; }
        public void setProject(String project) { this.project = project; }
        public String getDataset() { return dataset; }
        public void setDataset(String dataset) { this.dataset = dataset; }
    }

    /**
     * PostgreSQL structured data config.
     * Used by datasets whose relational data lives in the kg Postgres database
     * (e.g. insurance with the acme_insurance schema).
     */
    public static class PostgresConfig {
        private boolean enabled;
        /**
         * PostgreSQL schema name within the kg database.
         * Used to resolve {schema} template variables in R2RML SQL bindings.
         */
        private String schema;

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getSchema() { return schema; }
        public void setSchema(String schema) { this.schema = schema; }
    }

    /**
     * Computed named graph URIs for a dataset.
     * Never read from the manifest — always derived from the dataset id.
     * Convention: urn:{dataset-id}:{graph-role}
     */
    public record NamedGraphs(String datasetId) {
        public String tbox()          { return "urn:" + datasetId + ":tbox:ontology"; }
        public String rulesForward()  { return "urn:" + datasetId + ":tbox:rules:forward"; }
        public String rulesBackward() { return "urn:" + datasetId + ":tbox:rules:backward"; }
        /** R2RML/RML semantic bindings (new format). Loaded from DatasetConfig.bindingsPath if set. */
        public String bindings()      { return "urn:" + datasetId + ":bindings"; }
        public String aboxAsserted()  { return "urn:" + datasetId + ":abox:asserted"; }
        public String aboxInferred()  { return "urn:" + datasetId + ":abox:inferred"; }
        public String normalization() { return "urn:" + datasetId + ":normalization"; }
        public String provenance()    { return "urn:" + datasetId + ":provenance"; }
        public String systemHealth()  { return "urn:" + datasetId + ":system:health"; }
    }
}
