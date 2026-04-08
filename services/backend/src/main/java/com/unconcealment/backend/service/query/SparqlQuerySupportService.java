package com.unconcealment.backend.service.query;

import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionBuilder;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdfconnection.RDFConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

@Service
public class SparqlQuerySupportService {

    private static final Logger log = LoggerFactory.getLogger(SparqlQuerySupportService.class);

    public String executeConnectionSelectAsJson(RDFConnection conn, Query query) {
        try (QueryExecution qExec = conn.query(query)) {
            ResultSet rs = qExec.execSelect();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ResultSetFormatter.outputAsJSON(out, rs);
            return out.toString(StandardCharsets.UTF_8);
        }
    }

    public String executeModelSelectAsJson(Query query, Model model, long timeoutMs) {
        QueryExecutionBuilder builder = QueryExecution.model(model).query(query);
        if (timeoutMs > 0) {
            builder = builder.timeout(timeoutMs, TimeUnit.MILLISECONDS);
        }

        try (QueryExecution qExec = builder.build()) {
            ResultSet rs = qExec.execSelect();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ResultSetFormatter.outputAsJSON(out, rs);
            return out.toString(StandardCharsets.UTF_8);
        }
    }

    public String injectFromClauses(String sparql, String... graphUris) {
        try {
            Query query = QueryFactory.create(sparql);
            for (String uri : graphUris) {
                query.addGraphURI(uri);
            }
            return query.serialize();
        } catch (Exception e) {
            log.warn("FROM clause injection failed, using original query: {}", e.getMessage());
            return sparql;
        }
    }
}
