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

    public String getBaseUri() { return baseUri; }
    public void setBaseUri(String baseUri) { this.baseUri = baseUri; }

    public List<DatasetConfig> getDatasets() { return datasets; }
    public void setDatasets(List<DatasetConfig> datasets) { this.datasets = datasets; }

    public static class DatasetConfig {
        private String id;
        private String label;
        private String description;
        /** Optional per-dataset base URI override. Falls back to manifest-level baseUri. */
        private String baseUri;
        private String ontologyPath;
        private RulesPaths rules;
        private String fusekiDataset;
        private BigQueryConfig bigquery;

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

        public BigQueryConfig getBigquery() { return bigquery; }
        public void setBigquery(BigQueryConfig bigquery) { this.bigquery = bigquery; }

        /**
         * Returns named graph URIs derived from the dataset id.
         * Convention: urn:{dataset-id}:{graph-role}
         */
        public NamedGraphs namedGraphs() {
            return new NamedGraphs(id);
        }
    }

    /**
     * Resolves the effective base URI for a dataset.
     * Dataset-level baseUri takes precedence over the manifest-level default.
     */
    public String resolveBaseUri(DatasetConfig dataset) {
        return dataset.getBaseUri() != null ? dataset.getBaseUri() : this.baseUri;
    }

    /**
     * IRI segment labels, read from manifest.iriMinting.
     * Keys are segment identifiers (e.g. "tboxSegment", "aboxSegment");
     * values are the URL path segments used when minting IRIs.
     * Adding a new segment only requires updating manifest.yaml — no code change.
     */
    private java.util.Map<String, String> iriMinting;

    public java.util.Map<String, String> getIriMinting() { return iriMinting; }
    public void setIriMinting(java.util.Map<String, String> iriMinting) { this.iriMinting = iriMinting; }

    /**
     * Mints a stable IRI using a segment key looked up from manifest.iriMinting.
     * Pattern: {baseUri}/{segment}/{uuid}
     *
     * segmentKey is a key into iriMinting (e.g. "tboxSegment", "aboxSegment",
     * or any future key added to manifest.yaml). No segment values are hardcoded.
     *
     * Example:
     *   manifest.mintIri(dataset, "aboxSegment", uuid)
     *   → "https://kg.unconcealment.io/entity/a7f3c291-..."
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

    /**
     * Computed named graph URIs for a dataset.
     * Never read from the manifest — always derived from the dataset id.
     */
    public record NamedGraphs(String datasetId) {
        public String tbox()          { return "urn:" + datasetId + ":tbox:ontology"; }
        public String rulesForward()  { return "urn:" + datasetId + ":tbox:rules:forward"; }
        public String rulesBackward() { return "urn:" + datasetId + ":tbox:rules:backward"; }
        public String aboxAsserted()  { return "urn:" + datasetId + ":abox:asserted"; }
        public String aboxInferred()  { return "urn:" + datasetId + ":abox:inferred"; }
        public String normalization() { return "urn:" + datasetId + ":normalization"; }
        public String provenance()    { return "urn:" + datasetId + ":provenance"; }
        public String systemHealth()  { return "urn:" + datasetId + ":system:health"; }
    }
}
