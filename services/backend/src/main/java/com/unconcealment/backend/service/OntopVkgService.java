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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.File;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Virtual Knowledge Graph service using Ontop.
 *
 * Translates SPARQL SELECT queries to PostgreSQL SQL via the OBDA mapping defined in
 * ontology/{datasetId}/ontop.obda, without executing the SQL.
 *
 * The caller receives the SQL string and runs it against postgres-kg themselves.
 *
 * One Ontop query engine is created per postgres-enabled dataset at startup
 * and held for the lifetime of the application.
 */
@Service
public class OntopVkgService {

    private static final Logger log = LoggerFactory.getLogger(OntopVkgService.class);
    private static final Pattern BARE_DATE_LITERAL = Pattern.compile("([\"'])(\\d{4}-\\d{2}-\\d{2})\\1");
    private static final Pattern RDF_PREFIX_DECL = Pattern.compile("(?i)\\bprefix\\s+rdf\\s*:");
    private static final Pattern XSD_PREFIX_DECL = Pattern.compile("(?i)\\bprefix\\s+xsd\\s*:");

    /** Maps dataset id → Ontop query engine (one per postgres-enabled dataset). */
    private final Map<String, OntopQueryEngine> engines = new HashMap<>();

    private final DatasetManifest manifest;
    private final String jdbcUrl;
    private final String jdbcUser;
    private final String jdbcPassword;
    public record TranslationResult(String sql, boolean projectedApplied) {}

    public OntopVkgService(
            DatasetManifest manifest,
            @Value("${app.postgres.url}") String jdbcUrl,
            @Value("${app.postgres.username}") String jdbcUser,
            @Value("${app.postgres.password}") String jdbcPassword) {
        this.manifest = manifest;
        this.jdbcUrl = jdbcUrl;
        this.jdbcUser = jdbcUser;
        this.jdbcPassword = jdbcPassword;
    }

    @PostConstruct
    public void init() {
        for (DatasetConfig ds : manifest.getDatasets()) {
            if (ds.getPostgres() != null && ds.getPostgres().isEnabled()) {
                try {
                    initEngine(ds);
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
     * Translates a SPARQL SELECT query to a PostgreSQL SQL string via Ontop reformulation.
     * Strips any SERVICE :mapped { } wrapper from benchmark queries before translation.
     *
     * @param datasetId dataset ID (must be postgres-enabled, e.g. "insurance")
     * @param sparqlRaw raw SPARQL string (may contain SERVICE wrapper)
     * @return SQL string ready to execute against the configured schema
     * @throws IllegalArgumentException if dataset not found or not VKG-enabled
     * @throws OntopConnectionException if Ontop connection fails
     * @throws OntopReformulationException if SPARQL cannot be reformulated to SQL
     * @throws OntopInvalidKGQueryException if the SPARQL is syntactically invalid
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
                "Ensure postgres.enabled=true in manifest.yaml and that ontop.obda exists."
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
            String sql = translation.sql();
            log.debug("[ontop][{}] Produced SQL:\n{}", datasetId, sql);
            return translation;
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

    private void initEngine(DatasetConfig ds) throws OBDASpecificationException, OntopConnectionException {
        File ontologyFile = new File(ds.getOntologyPath());
        File obdaFile = resolveObdaFile(ds);

        OntopSQLOWLAPIConfiguration config = OntopSQLOWLAPIConfiguration.defaultBuilder()
            .ontologyFile(ontologyFile.getAbsolutePath())
            .nativeOntopMappingFile(obdaFile.getAbsolutePath())
            .jdbcUrl(jdbcUrl)
            .jdbcUser(jdbcUser)
            .jdbcPassword(jdbcPassword)
            .jdbcDriver("org.postgresql.Driver")
            .build();

        OntopQueryEngine engine = config.loadQueryEngine();
        engine.connect();
        engines.put(ds.getId(), engine);
    }

    /**
     * Resolves the OBDA mapping file for a dataset.
     * Looks for ontop.obda alongside the ontology file.
     * e.g. ontologyPath = "ontology/insurance/core.ttl"
     *      → obda path  = "ontology/insurance/ontop.obda"
     */
    private File resolveObdaFile(DatasetConfig ds) {
        File ontologyFile = new File(ds.getOntologyPath());
        File obdaFile = new File(ontologyFile.getParent(), "ontop.obda");
        if (!obdaFile.exists()) {
            throw new IllegalStateException(
                "Ontop OBDA mapping not found at: " + obdaFile.getAbsolutePath() +
                ". Create ontology/" + ds.getId() + "/ontop.obda to enable VKG."
            );
        }
        return obdaFile;
    }

    /**
     * Walks the IQ tree to find the NativeNode and extract the SQL string.
     * After full reformulation, the tree root is typically a NativeNode (leaf)
     * or has a NativeNode as a descendant.
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
     *
     * Example:
     *   WHERE { SERVICE :mapped { ?p a in:Policy } }
     *   →  WHERE { ?p a in:Policy }
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

    /**
     * Some benchmark queries use rdf:type without declaring the rdf prefix.
     * Add it on the fly so Jena can parse and we can strip SERVICE wrappers.
     */
    private String ensureRdfPrefix(String sparql) {
        String lower = sparql.toLowerCase();
        if (lower.contains("rdf:") && !RDF_PREFIX_DECL.matcher(sparql).find()) {
            return "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n" + sparql;
        }
        return sparql;
    }

    /**
     * Normalizes benchmark SPARQL quirks:
     * 1) bare 'YYYY-MM-DD' literals used in FILTER comparisons become xsd:dateTime literals.
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
