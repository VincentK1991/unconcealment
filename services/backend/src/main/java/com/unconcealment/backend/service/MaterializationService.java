package com.unconcealment.backend.service;

import com.unconcealment.backend.model.DatasetManifest.NamedGraphs;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.InfModel;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.reasoner.rulesys.GenericRuleReasoner;
import org.apache.jena.reasoner.rulesys.Rule;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Materializes owl:sameAs inferences into abox:inferred using Jena's forward-chaining rule engine.
 *
 * The endpoint POST /ingest/normalize is purpose-built for sameAs normalization.
 * The four sameAs rules (symmetry, transitivity, property propagation fwd+bwd) are hardcoded
 * here because they are universal OWL semantics and will not change.
 *
 * Uses FORWARD mode (not HYBRID) so backward rules never fire — this allows safely loading
 * both abox:asserted and normalization into the base model without the OOM risk that affects
 * the /query/reasoned endpoint in HYBRID mode.
 */
@Service
public class MaterializationService {

    private static final Logger log = LoggerFactory.getLogger(MaterializationService.class);

    private static final String OWL_PREFIX = "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n";

    /**
     * The four owl:sameAs rules. Hardcoded because:
     *   1. This service is purpose-built for sameAs normalization.
     *   2. These are universal OWL semantics — they will not change.
     *   3. Fetching them from the RDF store would add an unnecessary round-trip.
     */
    private static final List<Rule> SAME_AS_RULES = Rule.parseRules(
        OWL_PREFIX +
        "[sameAsSymm:   (?a owl:sameAs ?b) -> (?b owl:sameAs ?a)]\n" +
        "[sameAsTrans:  (?a owl:sameAs ?b), (?b owl:sameAs ?c) -> (?a owl:sameAs ?c)]\n" +
        "[sameAsPropFwd: (?a owl:sameAs ?b), (?a ?p ?o) -> (?b ?p ?o)]\n" +
        "[sameAsPropBwd: (?a owl:sameAs ?b), (?b ?p ?o) -> (?a ?p ?o)]\n"
    );

    /**
     * Loads the normalization and abox:asserted graphs, runs the sameAs forward rules,
     * and writes the deduced triples into abox:inferred (replacing any previous content).
     *
     * @return number of deduced triples written to abox:inferred
     */
    public long materializeSameAs(String datasetId, RDFConnection conn, NamedGraphs graphs) {
        log.info("[{}] Starting sameAs materialization", datasetId);

        // 1. Load normalization + abox:asserted into a single base model.
        //    Using CONSTRUCT with FILTER(isIRI(?s)) to exclude blank-node reification subjects
        //    that carry RDF-star provenance annotations (conn.fetch() cannot parse Turtle 1.2 <<>>).
        Model baseModel = loadGraphIriTriples(conn, graphs.normalization(), datasetId, "normalization");
        baseModel.add(loadGraphIriTriples(conn, graphs.aboxAsserted(), datasetId, "abox:asserted"));
        log.debug("[{}] Base model loaded: {} triples", datasetId, baseModel.size());

        // 2. Build a FORWARD-mode reasoner with the hardcoded sameAs rules.
        //    FORWARD mode runs rules only during prepare() — no backward expansion at query time,
        //    so the open ?p ?o pattern in prop-fwd/bwd does not cause OOM.
        GenericRuleReasoner reasoner = new GenericRuleReasoner(SAME_AS_RULES);
        reasoner.setMode(GenericRuleReasoner.FORWARD);

        InfModel infModel = ModelFactory.createInfModel(reasoner, baseModel);
        infModel.prepare();

        // 3. Extract only the inferred triples (not the base model triples).
        Model deductions = infModel.getDeductionsModel();
        long count = deductions.size();
        log.info("[{}] Jena forward rules produced {} deduction triple(s)", datasetId, count);

        // 4. Write deductions to abox:inferred via GSP HTTP PUT (replaces graph entirely).
        //    conn.load(graphUri, model) uses the GSP endpoint configured in JenaConfig.
        conn.load(graphs.aboxInferred(), deductions);
        log.info("[{}] Written {} triple(s) to <{}>", datasetId, count, graphs.aboxInferred());

        return count;
    }

    /**
     * CONSTRUCT-based graph loader — mirrors the approach in QueryController.loadGraphIriTriples.
     *
     * conn.fetch() downloads Turtle from Fuseki but cannot parse Turtle 1.2 RDF-star syntax
     * (<<...>> triple terms in blank-node reification subjects). CONSTRUCT avoids this: Fuseki
     * handles RDF-star natively and we project only IRI-subject triples, which are standard Turtle.
     */
    private Model loadGraphIriTriples(RDFConnection conn, String graphUri, String datasetId, String role) {
        String constructSparql =
            "CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <" + graphUri + "> { " +
            "?s ?p ?o . FILTER(isIRI(?s)) } }";
        Model model = ModelFactory.createDefaultModel();
        try {
            Query q = QueryFactory.create(constructSparql);
            try (QueryExecution qe = conn.query(q)) {
                qe.execConstruct(model);
            }
        } catch (Exception e) {
            log.warn("[{}] Could not load IRI triples from {} <{}>: {}", datasetId, role, graphUri, e.getMessage());
        }
        log.debug("[{}] Loaded {} triples from {} <{}>", datasetId, model.size(), role, graphUri);
        return model;
    }
}
