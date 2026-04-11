package com.unconcealment.backend;

import com.unconcealment.backend.service.OntopVkgService;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;
import org.apache.jena.vocabulary.RDF;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSetMetaData;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Integration test: runs all 44 benchmark Inquiries through OntopVkgService,
 * translating each SPARQL query to SQL via Ontop and comparing the result set
 * against the ground-truth SQL from the benchmark.
 *
 * Requires postgres-kg to be running on localhost:5433 (docker-compose up postgres-kg).
 * Run with: mvn test -Dtest=OntopBenchmarkTest -Dgroups=integration
 */
@SpringBootTest
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class OntopBenchmarkTest {

    private static final Logger log = LoggerFactory.getLogger(OntopBenchmarkTest.class);

    private static final String BENCHMARK_TTL =
        "data/cwd-benchmark-data/ACME_Insurance/investigation/acme-benchmark.ttl";

    private static final String INQUIRY_TYPE = "http://models.data.world/benchmarks/QandA#Inquiry";
    private static final String SPARQL_QUERY_TYPE = "https://templates.data.world/SparqlQuery";
    private static final String SQL_QUERY_TYPE = "https://templates.data.world/SqlQuery";
    private static final String EXPECTS_PROP = "http://models.data.world/benchmarks/QandA#expects";
    private static final String QUERY_TEXT_PROP = "http://models.data.world/benchmarks/QandA#queryText";
    private static final String PROMPT_PROP = "http://models.data.world/benchmarks/QandA#prompt";
    private static final Pattern DATE_DIFF_PATTERN = Pattern.compile(
        "(?i)DATE_DIFF\\s*\\(\\s*([^,]+?)\\s*,\\s*([^,]+?)\\s*,\\s*['\"]day['\"]\\s*\\)");
    private static final Pattern BAD_POLICY_AMOUNT_JOIN = Pattern.compile(
        "(?i)inner\\s+join\\s+policy_amount\\s+on\\s+policy\\.policy_identifier\\s*=\\s*policy_amount\\.policy_identifier");
    private static final DateTimeFormatter CANONICAL_TS =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    @Autowired
    private OntopVkgService ontopVkgService;

    private Connection jdbc;
    private boolean dateDiffSupported;
    private final List<BenchmarkCsvRow> csvRows = new ArrayList<>();

    record InquiryPair(String inquiryUri, String prompt, String sparqlText, String groundTruthSql) {}
    record BenchmarkCsvRow(
        String query,
        String sparql,
        String generatedRawSql,
        String generatedProjectedSql,
        String projectedApplied,
        String expectedSql,
        String generatedRawResult,
        String generatedProjectedResult,
        String expectedResult
    ) {}

    @BeforeAll
    void openConnection() throws Exception {
        jdbc = DriverManager.getConnection(
            "jdbc:postgresql://localhost:5433/kg", "admin", "test1234");
        try (java.sql.Statement stmt = jdbc.createStatement()) {
            stmt.execute("SET search_path TO acme_insurance, public");
        }
        dateDiffSupported = detectDateDiffSupport();
        log.info("[benchmark] Postgres DATE_DIFF support: {}", dateDiffSupported);
    }

    @AfterAll
    void closeConnection() throws Exception {
        writeCsvOutput();
        if (jdbc != null && !jdbc.isClosed()) {
            jdbc.close();
        }
    }

    Stream<Arguments> inquiryPairs() throws Exception {
        List<InquiryPair> pairs = extractInquiryPairs();
        log.info("[benchmark] Loaded {} inquiry pairs from {}", pairs.size(), BENCHMARK_TTL);
        return pairs.stream()
            .map(pair -> Arguments.of(pair.prompt(), pair));
    }

    @ParameterizedTest(name = "[{index}] {0}")
    @MethodSource("inquiryPairs")
    void inquiryResultSetsMatch(String prompt, InquiryPair pair) throws Exception {
        // The benchmark includes DATE_DIFF queries from data.world SQL/SPARQL.
        // Skip those inquiries when the function is unavailable in local Postgres.
        assumeTrue(
            dateDiffSupported || !containsDateDiff(pair),
            () -> {
                csvRows.add(new BenchmarkCsvRow(
                    prompt,
                    pair.sparqlText(),
                    "<SKIPPED>",
                    "<SKIPPED>",
                    "<SKIPPED>",
                    normalizeGroundTruthSql(pair.groundTruthSql()),
                    "<SKIPPED: DATE_DIFF unsupported>",
                    "<SKIPPED: DATE_DIFF unsupported>",
                    "<SKIPPED>"
                ));
                return "Skipping inquiry due to missing DATE_DIFF support in Postgres: " + prompt;
            }
        );

        // 1. Translate SPARQL to SQL via Ontop (raw + projected)
        String rawSql;
        List<List<String>> rawRows;
        String projectedSql;
        List<List<String>> projectedRows;
        boolean projectedApplied;
        try {
            var rawTranslation = ontopVkgService.translate("insurance", pair.sparqlText(), false);
            rawSql = rawTranslation.sql();
            assertThat(rawSql).as("Ontop raw translation for: %s", prompt).isNotBlank();
            rawRows = executeAndNormalize(rawSql);
        } catch (RuntimeException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("did not produce a NativeNode") && msg.contains("EMPTY")) {
                rawSql = "<EMPTY_IQ>";
                rawRows = List.of();
                log.info("[benchmark] Ontop produced EMPTY IQ (raw) for '{}'; treating as empty result set", prompt);
            } else {
                throw e;
            }
        }
        try {
            var projectedTranslation = ontopVkgService.translate("insurance", pair.sparqlText(), true);
            projectedSql = projectedTranslation.sql();
            projectedApplied = projectedTranslation.projectedApplied();
            assertThat(projectedSql).as("Ontop projected translation for: %s", prompt).isNotBlank();
            log.info("[benchmark] Ontop projected SQL for '{}': {}", prompt, projectedSql.replace("\n", " "));
            projectedRows = executeAndNormalize(projectedSql);
        } catch (RuntimeException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("did not produce a NativeNode") && msg.contains("EMPTY")) {
                projectedSql = "<EMPTY_IQ>";
                projectedRows = List.of();
                projectedApplied = false;
                log.info("[benchmark] Ontop produced EMPTY IQ (projected) for '{}'; treating as empty result set", prompt);
            } else {
                throw e;
            }
        }

        // 3. Execute ground-truth SQL
        String normalizedTruthSql = normalizeGroundTruthSql(pair.groundTruthSql());
        List<List<String>> truthRows = executeAndNormalize(normalizedTruthSql);
        List<List<String>> rawOntopRows = new ArrayList<>(rawRows);
        List<List<String>> projectedOntopRows = new ArrayList<>(projectedRows);

        // 4. Align Ontop columns to expected shape.
        List<List<String>> alignedOntopRows = alignOntopColumnsToExpected(projectedRows, truthRows);
        int alignedCols = alignedOntopRows.isEmpty() ? 0 : alignedOntopRows.get(0).size();
        int truthCols = truthRows.isEmpty() ? 0 : truthRows.get(0).size();
        assertThat(alignedCols)
            .as("Column count mismatch for: %s\nOntop SQL: %s\nGround-truth SQL: %s",
                prompt, projectedSql, normalizedTruthSql)
            .isEqualTo(truthCols);

        // 5. Compare row data
        assertThat(alignedOntopRows)
            .as("Result-set mismatch for: %s\nOntop SQL: %s\nGround-truth SQL: %s",
                prompt, projectedSql, normalizedTruthSql)
            .isEqualTo(truthRows);

        csvRows.add(new BenchmarkCsvRow(
            prompt,
            pair.sparqlText(),
            rawSql,
            projectedSql,
            String.valueOf(projectedApplied),
            normalizedTruthSql,
            rawOntopRows.toString(),
            projectedOntopRows.toString(),
            truthRows.toString()
        ));

        log.info("[benchmark] PASS: {} ({} rows)", prompt, alignedOntopRows.size());
    }

    private List<List<String>> executeAndNormalize(String sql) throws Exception {
        List<List<String>> rows = new ArrayList<>();
        try (java.sql.Statement stmt = jdbc.createStatement();
             java.sql.ResultSet rs = stmt.executeQuery(sql)) {
            ResultSetMetaData meta = rs.getMetaData();
            int colCount = meta.getColumnCount();
            while (rs.next()) {
                List<String> row = new ArrayList<>(colCount);
                for (int c = 1; c <= colCount; c++) {
                    Object val = rs.getObject(c);
                    row.add(normalizeValue(val));
                }
                rows.add(row);
            }
        }
        rows.sort(Comparator.comparing(row -> String.join("|", row)));
        return rows;
    }

    private String normalizeValue(Object val) {
        if (val == null) return "<NULL>";
        if (val instanceof BigDecimal bd) return bd.stripTrailingZeros().toPlainString();
        if (val instanceof java.sql.Timestamp ts) {
            return ts.toLocalDateTime().withNano(0).format(CANONICAL_TS);
        }
        if (val instanceof java.sql.Date d) return d.toLocalDate().toString();
        if (val instanceof Number n) return new BigDecimal(n.toString()).stripTrailingZeros().toPlainString();
        return normalizeStringValue(val.toString().trim());
    }

    private String normalizeStringValue(String value) {
        if (isNumeric(value)) {
            try {
                return new BigDecimal(value).stripTrailingZeros().toPlainString();
            } catch (NumberFormatException ignored) {
                // fall through
            }
        }
        if (value.endsWith("Z")) {
            try {
                return LocalDateTime.parse(value.substring(0, value.length() - 1)).withNano(0).format(CANONICAL_TS);
            } catch (DateTimeParseException ignored) {
                // keep original
            }
        }
        try {
            return LocalDateTime.parse(value).withNano(0).format(CANONICAL_TS);
        } catch (DateTimeParseException ignored) {
            return value;
        }
    }

    private boolean isNumeric(String value) {
        return value.matches("[-+]?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?");
    }

    private boolean detectDateDiffSupport() {
        final String sql = "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'date_diff')";
        try (java.sql.Statement stmt = jdbc.createStatement();
             java.sql.ResultSet rs = stmt.executeQuery(sql)) {
            return rs.next() && rs.getBoolean(1);
        } catch (Exception e) {
            log.warn("[benchmark] Could not detect DATE_DIFF support, treating as unsupported: {}", e.getMessage());
            return false;
        }
    }

    private boolean containsDateDiff(InquiryPair pair) {
        String sparql = pair.sparqlText() == null ? "" : pair.sparqlText().toLowerCase(Locale.ROOT);
        String sql = pair.groundTruthSql() == null ? "" : pair.groundTruthSql().toLowerCase(Locale.ROOT);
        return sparql.contains("date_diff(") || sql.contains("date_diff(") || sparql.contains("fn:date_diff");
    }

    private String normalizeGroundTruthSql(String sql) {
        String text = sql == null ? "" : sql.replace("\r\n", "\n").replace('\r', '\n');
        text = stripHashCommentLines(text);
        text = rewriteDateDiffToPostgres(text);
        text = rewritePolicyAmountJoin(text);
        return text;
    }

    private String stripHashCommentLines(String sql) {
        StringBuilder out = new StringBuilder();
        for (String line : sql.split("\n")) {
            if (line.trim().startsWith("#")) {
                continue;
            }
            out.append(line).append('\n');
        }
        return out.toString();
    }

    private String rewriteDateDiffToPostgres(String sql) {
        Matcher m = DATE_DIFF_PATTERN.matcher(sql);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String startExpr = m.group(1).trim();
            String endExpr = m.group(2).trim();
            String replacement = "(" + endExpr + "::date - " + startExpr + "::date)";
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private String rewritePolicyAmountJoin(String sql) {
        String replacement =
            "inner join policy_coverage_detail on policy.policy_identifier = policy_coverage_detail.policy_identifier\n" +
            "    inner join policy_amount on policy_coverage_detail.policy_coverage_detail_identifier = policy_amount.policy_coverage_detail_identifier";
        return BAD_POLICY_AMOUNT_JOIN.matcher(sql).replaceAll(replacement);
    }

    private List<List<String>> alignOntopColumnsToExpected(List<List<String>> actual, List<List<String>> expected) {
        if (actual.equals(expected) || actual.isEmpty() || expected.isEmpty()) {
            return actual;
        }
        int expectedColCount = expected.get(0).size();
        int actualColCount = actual.get(0).size();
        if (actualColCount < expectedColCount) {
            return actual;
        }

        List<String> actualSignatures = new ArrayList<>(actualColCount);
        List<String> expectedSignatures = new ArrayList<>(expectedColCount);
        for (int c = 0; c < actualColCount; c++) {
            actualSignatures.add(columnSignature(actual, c));
        }
        for (int c = 0; c < expectedColCount; c++) {
            expectedSignatures.add(columnSignature(expected, c));
        }

        Map<String, List<Integer>> actualIndexesBySignature = new HashMap<>();
        for (int i = 0; i < actualColCount; i++) {
            actualIndexesBySignature.computeIfAbsent(actualSignatures.get(i), k -> new ArrayList<>()).add(i);
        }

        List<List<Integer>> candidates = new ArrayList<>(expectedColCount);
        for (int expectedCol = 0; expectedCol < expectedColCount; expectedCol++) {
            List<Integer> opts = actualIndexesBySignature.getOrDefault(expectedSignatures.get(expectedCol), List.of());
            if (opts.isEmpty()) {
                return actual;
            }
            candidates.add(new ArrayList<>(opts));
        }

        Integer[] order = new Integer[expectedColCount];
        for (int i = 0; i < expectedColCount; i++) {
            order[i] = i; // expected column indexes
        }
        Arrays.sort(order, Comparator.comparingInt(i -> candidates.get(i).size()));

        int[] expectedToActual = new int[expectedColCount];
        Arrays.fill(expectedToActual, -1);
        boolean[] actualUsed = new boolean[actualColCount];

        int[] found = findExpectedToActualMapping(
            0, order, candidates, expectedToActual, actualUsed, actual, expected);

        if (found == null) {
            return actual;
        }

        List<List<String>> remapped = remapColumns(actual, found);
        remapped.sort(Comparator.comparing(row -> String.join("|", row)));
        if (actualColCount == expectedColCount) {
            log.info("[benchmark] Realigned Ontop result columns by permutation ({} columns, {} rows)",
                expectedColCount, remapped.size());
        } else {
            log.info("[benchmark] Aligned Ontop result by selecting {} of {} columns ({} rows)",
                expectedColCount, actualColCount, remapped.size());
        }
        return remapped;
    }

    private int[] findExpectedToActualMapping(
        int depth,
        Integer[] order,
        List<List<Integer>> candidates,
        int[] expectedToActual,
        boolean[] actualUsed,
        List<List<String>> actualRows,
        List<List<String>> expectedRows) {
        int colCount = order.length;
        if (depth == colCount) {
            List<List<String>> remapped = remapColumns(actualRows, expectedToActual);
            remapped.sort(Comparator.comparing(row -> String.join("|", row)));
            if (remapped.equals(expectedRows)) {
                return Arrays.copyOf(expectedToActual, expectedToActual.length);
            }
            return null;
        }

        int expectedCol = order[depth];
        for (int actualCol : candidates.get(expectedCol)) {
            if (actualUsed[actualCol]) {
                continue;
            }
            actualUsed[actualCol] = true;
            expectedToActual[expectedCol] = actualCol;

            int[] found = findExpectedToActualMapping(
                depth + 1, order, candidates, expectedToActual, actualUsed, actualRows, expectedRows);
            if (found != null) {
                return found;
            }

            expectedToActual[expectedCol] = -1;
            actualUsed[actualCol] = false;
        }
        return null;
    }

    private List<List<String>> remapColumns(List<List<String>> rows, int[] expectedToActual) {
        List<List<String>> remapped = new ArrayList<>(rows.size());
        for (List<String> row : rows) {
            List<String> newRow = new ArrayList<>(expectedToActual.length);
            for (int expectedCol = 0; expectedCol < expectedToActual.length; expectedCol++) {
                newRow.add(row.get(expectedToActual[expectedCol]));
            }
            remapped.add(newRow);
        }
        return remapped;
    }

    private String columnSignature(List<List<String>> rows, int col) {
        List<String> values = new ArrayList<>(rows.size());
        for (List<String> row : rows) {
            values.add(row.get(col));
        }
        values.sort(String::compareTo);
        return String.join("\u001F", values);
    }

    private List<InquiryPair> extractInquiryPairs() throws Exception {
        Model model = ModelFactory.createDefaultModel();
        try (FileInputStream in = new FileInputStream(BENCHMARK_TTL)) {
            model.read(in, null, "TURTLE");
        }

        Resource inquiryClass = model.createResource(INQUIRY_TYPE);
        Resource sparqlQueryClass = model.createResource(SPARQL_QUERY_TYPE);
        Resource sqlQueryClass = model.createResource(SQL_QUERY_TYPE);
        Property expectsProp = model.createProperty(EXPECTS_PROP);
        Property queryTextProp = model.createProperty(QUERY_TEXT_PROP);
        Property promptProp = model.createProperty(PROMPT_PROP);

        List<InquiryPair> pairs = new ArrayList<>();

        model.listSubjectsWithProperty(RDF.type, inquiryClass).toList().forEach(inquiry -> {
            String uri = inquiry.getURI();
            Statement promptStmt = inquiry.getProperty(promptProp);
            String prompt = promptStmt != null ? promptStmt.getString() : uri;

            String sparqlText = null;
            String sqlText = null;

            StmtIterator expectsIter = inquiry.listProperties(expectsProp);
            while (expectsIter.hasNext()) {
                Resource expectedQuery = expectsIter.next().getObject().asResource();
                if (expectedQuery.hasProperty(RDF.type, sparqlQueryClass)) {
                    Statement qt = expectedQuery.getProperty(queryTextProp);
                    if (qt != null) sparqlText = qt.getString();
                } else if (expectedQuery.hasProperty(RDF.type, sqlQueryClass)) {
                    Statement qt = expectedQuery.getProperty(queryTextProp);
                    if (qt != null) sqlText = qt.getString();
                }
            }

            if (sparqlText != null && sqlText != null) {
                pairs.add(new InquiryPair(uri, prompt, sparqlText, sqlText));
            } else {
                log.warn("[benchmark] Skipping inquiry {} — missing SPARQL or SQL counterpart", uri);
            }
        });

        return pairs;
    }

    private void writeCsvOutput() throws Exception {
        Path out = Path.of("target", "ontop-benchmark-output.csv");
        if (out.getParent() != null) {
            Files.createDirectories(out.getParent());
        }
        List<String> lines = new ArrayList<>();
        lines.add(String.join(",",
            csvEscape("query"),
            csvEscape("sparql"),
            csvEscape("generated raw sql"),
            csvEscape("generated projected sql"),
            csvEscape("projected applied"),
            csvEscape("expected sql"),
            csvEscape("generated raw result"),
            csvEscape("generated projected result"),
            csvEscape("expected result")
        ));
        for (BenchmarkCsvRow row : csvRows) {
            lines.add(String.join(",",
                csvEscape(row.query()),
                csvEscape(row.sparql()),
                csvEscape(row.generatedRawSql()),
                csvEscape(row.generatedProjectedSql()),
                csvEscape(row.projectedApplied()),
                csvEscape(row.expectedSql()),
                csvEscape(row.generatedRawResult()),
                csvEscape(row.generatedProjectedResult()),
                csvEscape(row.expectedResult())
            ));
        }
        Files.write(out, lines);
        log.info("[benchmark] Wrote CSV output: {}", out.toAbsolutePath());
    }

    private String csvEscape(String value) {
        String text = value == null ? "" : value;
        return "\"" + text.replace("\"", "\"\"") + "\"";
    }
}
