package com.unconcealment.backend.service;

import com.unconcealment.backend.model.DatasetManifest;
import com.unconcealment.backend.model.DatasetManifest.DatasetConfig;
import it.unibz.inf.ontop.answering.OntopQueryEngine;
import it.unibz.inf.ontop.answering.connection.OntopConnection;
import it.unibz.inf.ontop.answering.connection.OntopStatement;
import it.unibz.inf.ontop.exception.OBDASpecificationException;
import it.unibz.inf.ontop.exception.OntopConnectionException;
import it.unibz.inf.ontop.exception.OntopInvalidKGQueryException;
import it.unibz.inf.ontop.exception.OntopReformulationException;
import it.unibz.inf.ontop.injection.OntopSQLOWLAPIConfiguration;
import it.unibz.inf.ontop.iq.IQ;
import it.unibz.inf.ontop.iq.IQTree;
import it.unibz.inf.ontop.iq.UnaryIQTree;
import it.unibz.inf.ontop.iq.node.ConstructionNode;
import it.unibz.inf.ontop.iq.node.NativeNode;
import it.unibz.inf.ontop.model.term.ImmutableFunctionalTerm;
import it.unibz.inf.ontop.model.term.ImmutableTerm;
import it.unibz.inf.ontop.model.term.Variable;
import it.unibz.inf.ontop.query.KGQueryFactory;
import it.unibz.inf.ontop.query.SelectQuery;
import it.unibz.inf.ontop.dbschema.QuotedID;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.graph.Node;
import org.apache.jena.sparql.syntax.Element;
import org.apache.jena.sparql.syntax.ElementService;
import org.apache.jena.sparql.syntax.syntaxtransform.ElementTransformCopyBase;
import org.apache.jena.sparql.syntax.syntaxtransform.ElementTransformer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Virtual Knowledge Graph service using Ontop.
 *
 * Translates SPARQL SELECT queries to SQL via the OBDA mapping defined in
 * ontology/{datasetId}/ontop.obda, without executing the SQL.
 *
 * Domain-agnostic: JDBC settings are read from ontop.properties alongside
 * each dataset's ontop.obda. Optional ontop-table-map.properties enables
 * post-processing SQL rewrites (e.g. PostgreSQL table refs → BigQuery names).
 *
 * A dataset is Ontop-enabled if and only if both files exist:
 *   ontology/{datasetId}/ontop.obda
 *   ontology/{datasetId}/ontop.properties
 *
 * One Ontop query engine is created per enabled dataset at startup and held
 * for the lifetime of the application.
 */
@Service
public class OntopVkgService {

    private static final Logger log = LoggerFactory.getLogger(OntopVkgService.class);

    private static final Pattern BARE_DATE_LITERAL = Pattern.compile("([\"'])(\\d{4}-\\d{2}-\\d{2})\\1");
    private static final Pattern RDF_PREFIX_DECL   = Pattern.compile("(?i)\\bprefix\\s+rdf\\s*:");
    private static final Pattern XSD_PREFIX_DECL   = Pattern.compile("(?i)\\bprefix\\s+xsd\\s*:");
    /** Matches double-quoted SQL identifiers: "foo" — used for requoting to backtick style. */
    private static final Pattern DOUBLE_QUOTED_ID  = Pattern.compile("\"([^\"]+)\"");
    /** Property key in ontop-table-map.properties that controls identifier requoting. */
    private static final String PROP_ID_QUOTE      = "ontop.sql.rewrite.identifier.quote";

    /** Maps dataset id → Ontop query engine. */
    private final Map<String, OntopQueryEngine> engines = new HashMap<>();
    /**
     * Maps dataset id → ordered table-name replacement map.
     * Populated from ontop-table-map.properties when present.
     * Keys are exact strings to replace; values are their replacements.
     * Ordered (LinkedHashMap) so longer/more-specific keys are applied first
     * (file is read in declaration order).
     */
    private final Map<String, Map<String, String>> tableRewriteMaps = new HashMap<>();
    /**
     * Maps dataset id → identifier quoting mode.
     * "backtick" → convert remaining "id" tokens to `id` after table rewrites.
     */
    private final Map<String, String> identifierQuoteModes = new HashMap<>();

    private final DatasetManifest manifest;

    public record TranslationResult(String sql, boolean projectedApplied) {}

    public OntopVkgService(DatasetManifest manifest) {
        this.manifest = manifest;
    }

    @PostConstruct
    public void init() {
        for (DatasetConfig ds : manifest.getDatasets()) {
            File ontologyFile = new File(ds.getOntologyPath());
            File obdaFile     = new File(ontologyFile.getParent(), "ontop.obda");
            File propsFile    = new File(ontologyFile.getParent(), "ontop.properties");
            if (obdaFile.exists() && propsFile.exists()) {
                try {
                    initEngine(ds, ontologyFile, obdaFile, propsFile);
                    log.info("[ontop] Initialized VKG engine for dataset '{}'", ds.getId());
                } catch (Exception e) {
                    log.error("[ontop] Failed to initialize VKG for dataset '{}': {}",
                            ds.getId(), e.getMessage(), e);
                }
            }
        }
    }

    @PreDestroy
    public void shutdown() {
        for (Map.Entry<String, OntopQueryEngine> entry : engines.entrySet()) {
            try {
                entry.getValue().close();
            } catch (Exception e) {
                log.warn("[ontop] Error closing engine for '{}': {}", entry.getKey(), e.getMessage());
            }
        }
    }

    /**
     * Translates a SPARQL SELECT query to SQL via Ontop reformulation.
     * Strips any SERVICE :mapped { } wrapper from benchmark queries before translation.
     * Applies table-name and identifier rewrites from ontop-table-map.properties if present.
     *
     * @param datasetId dataset ID (must have ontop.obda + ontop.properties)
     * @param sparqlRaw raw SPARQL string (may contain SERVICE wrapper)
     * @return SQL string ready to run against the dataset's target database
     */
    public String translateToSql(String datasetId, String sparqlRaw)
            throws OntopConnectionException, OntopReformulationException, OntopInvalidKGQueryException {
        return translate(datasetId, sparqlRaw, false).sql();
    }

    /**
     * @param projectedOutput true to attempt outer SQL projection to SPARQL answer variables.
     */
    public TranslationResult translate(String datasetId, String sparqlRaw, boolean projectedOutput)
            throws OntopConnectionException, OntopReformulationException, OntopInvalidKGQueryException {
        OntopQueryEngine engine = engines.get(datasetId);
        if (engine == null) {
            throw new IllegalArgumentException(
                "No VKG engine for dataset '" + datasetId + "'. " +
                "Ensure ontop.obda and ontop.properties exist in the dataset's ontology folder."
            );
        }
        String sparql = normalizeSparql(stripServiceWrapper(sparqlRaw));
        log.debug("[ontop][{}] Translating SPARQL:\n{}", datasetId, sparql);

        try (OntopConnection conn = engine.getConnection();
             OntopStatement stmt = conn.createStatement()) {
            KGQueryFactory queryFactory = conn.getInputQueryFactory();
            SelectQuery selectQuery = queryFactory.createSelectQuery(sparql);
            IQ executableQuery = stmt.getExecutableQuery(selectQuery);
            NativeNode nativeNode = extractNativeNode(executableQuery);
            TranslationResult translation = projectedOutput
                ? wrapProjectedSql(executableQuery, nativeNode)
                : new TranslationResult(nativeNode.getNativeQueryString(), false);
            String sql = applyTableRewrite(translation.sql(), datasetId);
            log.debug("[ontop][{}] Produced SQL:\n{}", datasetId, sql);
            return new TranslationResult(sql, translation.projectedApplied());
        } catch (OntopConnectionException | OntopReformulationException | OntopInvalidKGQueryException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Ontop translation failed for dataset '" + datasetId + "': " + e.getMessage(), e);
        }
    }

    /** Returns true if a VKG engine is available for the given dataset. */
    public boolean isAvailable(String datasetId) {
        return engines.containsKey(datasetId);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private void initEngine(DatasetConfig ds, File ontologyFile, File obdaFile, File propsFile)
            throws OBDASpecificationException, OntopConnectionException, IOException {
        Properties p = loadOntopProperties(propsFile);

        OntopSQLOWLAPIConfiguration config = OntopSQLOWLAPIConfiguration.defaultBuilder()
            .ontologyFile(ontologyFile.getAbsolutePath())
            .nativeOntopMappingFile(obdaFile.getAbsolutePath())
            .jdbcUrl(p.getProperty("ontop.jdbc.url"))
            .jdbcUser(p.getProperty("ontop.jdbc.user"))
            .jdbcPassword(p.getProperty("ontop.jdbc.password"))
            .jdbcDriver(p.getProperty("ontop.jdbc.driver"))
            .build();

        OntopQueryEngine engine = config.loadQueryEngine();
        engine.connect();
        engines.put(ds.getId(), engine);

        // Load optional table-name rewrite map
        File tableMapFile = new File(obdaFile.getParent(), "ontop-table-map.properties");
        if (tableMapFile.exists()) {
            loadTableRewriteMap(ds.getId(), tableMapFile);
            log.info("[ontop] Loaded table-rewrite map for dataset '{}'", ds.getId());
        }
    }

    /**
     * Loads ontop.properties and resolves ${ENV_VAR:default} tokens using
     * System.getenv() with the declared fallback value.
     */
    private Properties loadOntopProperties(File propsFile) throws IOException {
        Properties raw = new Properties();
        try (FileInputStream fis = new FileInputStream(propsFile)) {
            raw.load(fis);
        }
        Pattern envToken = Pattern.compile("\\$\\{([^:}]+)(?::([^}]*))?\\}");
        Properties resolved = new Properties();
        for (String key : raw.stringPropertyNames()) {
            String value = raw.getProperty(key);
            Matcher m = envToken.matcher(value);
            StringBuffer sb = new StringBuffer();
            while (m.find()) {
                String envVar     = m.group(1);
                String defaultVal = m.group(2) != null ? m.group(2) : "";
                String envValue   = System.getenv(envVar);
                m.appendReplacement(sb, Matcher.quoteReplacement(envValue != null ? envValue : defaultVal));
            }
            m.appendTail(sb);
            resolved.setProperty(key, sb.toString());
        }
        return resolved;
    }

    /**
     * Loads ontop-table-map.properties into an ordered replacement map.
     * Lines whose keys start with a double-quote are table-name rewrites.
     * The special key ontop.sql.rewrite.identifier.quote controls requoting.
     */
    private void loadTableRewriteMap(String datasetId, File tableMapFile) throws IOException {
        // Use LinkedHashMap to preserve declaration order (more-specific keys first)
        Map<String, String> rewrites = new LinkedHashMap<>();
        Properties raw = new Properties() {
            // Override to preserve insertion order via LinkedHashMap backing
            private final LinkedHashMap<Object, Object> map = new LinkedHashMap<>();
            @Override public synchronized Object put(Object key, Object value) { return map.put(key, value); }
            @Override public String getProperty(String key) { return (String) map.get(key); }
            @Override public java.util.Set<String> stringPropertyNames() { return map.keySet().stream().map(Object::toString).collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new)); }
        };
        try (FileInputStream fis = new FileInputStream(tableMapFile)) {
            raw.load(fis);
        }
        for (String key : raw.stringPropertyNames()) {
            String value = raw.getProperty(key);
            if (PROP_ID_QUOTE.equals(key)) {
                identifierQuoteModes.put(datasetId, value);
            } else {
                rewrites.put(key, value);
            }
        }
        if (!rewrites.isEmpty()) {
            tableRewriteMaps.put(datasetId, rewrites);
        }
    }

    /**
     * Applies table-name and identifier rewrites from ontop-table-map.properties.
     * 1. Replaces every key in the rewrite map with its corresponding value.
     * 2. If identifier quote mode is "backtick", converts remaining "id" tokens to `id`.
     * No domain-specific logic; all rules come from the metadata file.
     */
    private String applyTableRewrite(String sql, String datasetId) {
        Map<String, String> rewrites = tableRewriteMaps.get(datasetId);
        if (rewrites == null || rewrites.isEmpty()) {
            return sql;
        }
        String result = sql;
        for (Map.Entry<String, String> entry : rewrites.entrySet()) {
            result = result.replace(entry.getKey(), entry.getValue());
        }
        String quoteMode = identifierQuoteModes.get(datasetId);
        if ("backtick".equals(quoteMode)) {
            result = DOUBLE_QUOTED_ID.matcher(result).replaceAll("`$1`");
        }
        return result;
    }

    /**
     * Walks the IQ tree to find the NativeNode and extract the SQL string.
     */
    private NativeNode extractNativeNode(IQ executableQuery) {
        NativeNode nativeNode = findNativeNode(executableQuery.getTree());
        if (nativeNode == null) {
            throw new RuntimeException(
                "Ontop reformulation did not produce a NativeNode. IQ tree: " + executableQuery);
        }
        return nativeNode;
    }

    /**
     * Wrap native SQL so output columns match SPARQL answer variables exactly
     * (order + count), instead of exposing Ontop helper/provenance columns.
     */
    private TranslationResult wrapProjectedSql(IQ executableQuery, NativeNode nativeNode) {
        String nativeSql = nativeNode.getNativeQueryString();
        var answerVars = executableQuery.getProjectionAtom().getArguments();
        if (answerVars.isEmpty()) {
            return new TranslationResult(nativeSql, false);
        }

        Map<String, QuotedID> nativeColsByVarName = new LinkedHashMap<>();
        nativeNode.getColumnNames().forEach((k, v) -> nativeColsByVarName.put(k.getName(), v));

        ConstructionNode constructionNode = extractTopConstructionNode(executableQuery.getTree());
        if (constructionNode == null) {
            return new TranslationResult(nativeSql, false);
        }
        var substitution = constructionNode.getSubstitution();

        StringBuilder sb = new StringBuilder("SELECT ");
        for (int i = 0; i < answerVars.size(); i++) {
            Variable var = answerVars.get(i);
            ImmutableTerm mappedTerm = substitution.isDefining(var) ? substitution.get(var) : var;
            Variable sourceVar = extractPrimarySourceVariable(mappedTerm);
            if (sourceVar == null) {
                return new TranslationResult(nativeSql, false);
            }
            QuotedID col = nativeColsByVarName.get(sourceVar.getName());
            if (col == null) {
                return new TranslationResult(nativeSql, false);
            }
            if (i > 0) {
                sb.append(", ");
            }
            sb.append("src.")
              .append(col.getSQLRendering())
              .append(" AS ")
              .append(quoteIdentifier(var.getName()));
        }
        sb.append("\nFROM (\n")
          .append(nativeSql)
          .append("\n) src");
        return new TranslationResult(sb.toString(), true);
    }

    private ConstructionNode extractTopConstructionNode(IQTree tree) {
        if (tree instanceof UnaryIQTree unary && unary.getRootNode() instanceof ConstructionNode constructionNode) {
            return constructionNode;
        }
        return null;
    }

    private Variable extractPrimarySourceVariable(ImmutableTerm term) {
        if (term instanceof Variable variable) {
            return variable;
        }
        if (term instanceof ImmutableFunctionalTerm functionalTerm) {
            for (ImmutableTerm child : functionalTerm.getTerms()) {
                Variable nested = extractPrimarySourceVariable(child);
                if (nested != null) {
                    return nested;
                }
            }
        }
        return null;
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private NativeNode findNativeNode(IQTree tree) {
        if (tree.getRootNode() instanceof NativeNode) {
            return (NativeNode) tree.getRootNode();
        }
        for (IQTree child : tree.getChildren()) {
            NativeNode found = findNativeNode(child);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    /**
     * Strips SERVICE :mapped { ... } or SERVICE ds-xxx:mapped { ... } wrappers
     * from benchmark SPARQL queries using Jena ARQ's ElementTransformer.
     */
    private String stripServiceWrapper(String sparql) {
        try {
            Query q = QueryFactory.create(ensureRdfPrefix(sparql));
            if (q.getQueryPattern() == null) {
                return sparql;
            }
            Element stripped = ElementTransformer.transform(
                q.getQueryPattern(),
                new ElementTransformCopyBase() {
                    @Override
                    public Element transform(ElementService el, Node endpoint, Element body) {
                        return body;
                    }
                }
            );
            q.setQueryPattern(stripped);
            return q.toString();
        } catch (Exception e) {
            log.debug("[ontop] Could not strip SERVICE wrapper (may not be present): {}", e.getMessage());
            return sparql;
        }
    }

    private String ensureRdfPrefix(String sparql) {
        String lower = sparql.toLowerCase();
        if (lower.contains("rdf:") && !RDF_PREFIX_DECL.matcher(sparql).find()) {
            return "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n" + sparql;
        }
        return sparql;
    }

    /**
     * Normalizes benchmark SPARQL quirks:
     * 1) bare 'YYYY-MM-DD' literals become xsd:dateTime literals.
     * 2) xsd prefix is ensured when such typed literals are injected.
     */
    private String normalizeSparql(String sparql) {
        String normalized = rewriteBareDateLiterals(sparql);
        normalized = ensureRdfPrefix(normalized);
        normalized = ensureXsdPrefix(normalized);
        return normalized;
    }

    private String rewriteBareDateLiterals(String sparql) {
        Matcher m = BARE_DATE_LITERAL.matcher(sparql);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String date = m.group(2);
            String replacement = "\"" + date + "T00:00:00\"^^xsd:dateTime";
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private String ensureXsdPrefix(String sparql) {
        String lower = sparql.toLowerCase();
        if (lower.contains("^^xsd:") && !XSD_PREFIX_DECL.matcher(sparql).find()) {
            return "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n" + sparql;
        }
        return sparql;
    }
}
