package com.unconcealment.backend.service.query;

import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdfconnection.RDFConnection;
import org.apache.jena.reasoner.rulesys.Rule;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
public class ReasoningAssetService {

    private static final Logger log = LoggerFactory.getLogger(ReasoningAssetService.class);

    public Model loadGraphIriTriples(RDFConnection conn, String graphUri) {
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
            log.warn("[reasoned] Could not load IRI triples from {}: {}", graphUri, e.getMessage());
        }
        log.debug("[reasoned] Loaded {} triples from {}", model.size(), graphUri);
        return model;
    }

    public List<Rule> loadRules(RDFConnection conn, String graphUri, String ruleType, int maxOrder) {
        List<Rule> rules = new ArrayList<>();
        String orderFilter = (maxOrder < Integer.MAX_VALUE)
                ? "FILTER(!BOUND(?order) || ?order <= " + maxOrder + ") "
                : "";
        String loadSparql =
                "PREFIX ex: <https://kg.unconcealment.io/ontology/> " +
                "SELECT ?body ?order WHERE { GRAPH <" + graphUri + "> { " +
                "?r a ex:" + ruleType + " ; ex:ruleBody ?body . " +
                "OPTIONAL { ?r ex:ruleOrder ?order } " + orderFilter + "} } ORDER BY ?order";
        try {
            Query q = QueryFactory.create(loadSparql);
            try (QueryExecution qe = conn.query(q)) {
                ResultSet rs = qe.execSelect();
                String prefixes =
                        "@prefix ex:   <https://kg.unconcealment.io/ontology/> .\n" +
                        "@prefix owl:  <http://www.w3.org/2002/07/owl#> .\n" +
                        "@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n" +
                        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n";
                while (rs.hasNext()) {
                    String body = rs.next().getLiteral("body").getString();
                    try {
                        rules.addAll(Rule.parseRules(prefixes + body));
                    } catch (Exception e) {
                        log.warn("[reasoned] Failed to parse {}: {} — {}", ruleType, body, e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[reasoned] Could not load {} from {}: {}", ruleType, graphUri, e.getMessage());
        }
        log.debug("[reasoned] Loaded {} rules from {} ({})", rules.size(), graphUri, ruleType);
        return rules;
    }
}
