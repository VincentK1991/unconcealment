package com.unconcealment.backend.service.query;

import org.apache.jena.graph.Node;
import org.apache.jena.query.Query;
import org.apache.jena.reasoner.TriplePattern;
import org.apache.jena.reasoner.rulesys.ClauseEntry;
import org.apache.jena.reasoner.rulesys.Functor;
import org.apache.jena.reasoner.rulesys.Rule;
import org.apache.jena.sparql.core.TriplePath;
import org.apache.jena.sparql.syntax.ElementPathBlock;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
import org.springframework.stereotype.Service;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class PlaygroundRuleAnalyzer {

    private static final Pattern TABLE_DIRECTIVE =
            Pattern.compile("\\btable\\s*\\(\\s*([^\\)]+?)\\s*\\)");
    private static final Pattern TABLE_ALL_DIRECTIVE =
            Pattern.compile("\\btableAll\\s*\\(\\s*\\)");

    public PlaygroundRuleAnalysis analyze(List<Rule> rules, String ruleText) {
        boolean hasBackwardRules = false;
        boolean hasForwardRules = false;
        boolean tableAll = false;
        Set<String> recursivePredicates = new LinkedHashSet<>();
        Set<String> tabledPredicates = new LinkedHashSet<>();

        for (Rule rule : rules) {
            boolean hasTriplePattern = containsTriplePattern(rule.getHead()) || containsTriplePattern(rule.getBody());
            if (hasTriplePattern) {
                if (rule.isBackward()) {
                    hasBackwardRules = true;
                } else {
                    hasForwardRules = true;
                }
            }

            Set<String> headPredicates = extractRulePredicates(rule.getHead());
            Set<String> bodyPredicates = extractRulePredicates(rule.getBody());
            Set<String> overlap = new LinkedHashSet<>(headPredicates);
            overlap.retainAll(bodyPredicates);
            recursivePredicates.addAll(overlap);

            collectTableDirectivePredicates(rule.getHead(), tabledPredicates);
            collectTableDirectivePredicates(rule.getBody(), tabledPredicates);
            tableAll = tableAll || containsTableAllDirective(rule.getHead()) || containsTableAllDirective(rule.getBody());
        }

        if (!tableAll && ruleText != null && TABLE_ALL_DIRECTIVE.matcher(ruleText).find()) {
            tableAll = true;
        }
        if (tabledPredicates.isEmpty() && ruleText != null) {
            Matcher matcher = TABLE_DIRECTIVE.matcher(ruleText);
            while (matcher.find()) {
                tabledPredicates.add(normalizePredicateToken(matcher.group(1)));
            }
        }

        return new PlaygroundRuleAnalysis(
                hasBackwardRules,
                hasForwardRules,
                tableAll,
                Set.copyOf(recursivePredicates),
                Set.copyOf(tabledPredicates)
        );
    }

    public boolean hasInvalidBackwardRuleConsequentCount(List<Rule> rules) {
        for (Rule rule : rules) {
            boolean hasTriplePattern = containsTriplePattern(rule.getHead()) || containsTriplePattern(rule.getBody());
            if (hasTriplePattern && rule.isBackward() && rule.headLength() != 1) {
                return true;
            }
        }
        return false;
    }

    public boolean hasUnsafeRecursiveQueryShape(Query query) {
        if (query.getQueryPattern() == null) {
            return false;
        }
        AtomicBoolean unsafe = new AtomicBoolean(false);
        ElementWalker.walk(query.getQueryPattern(), new ElementVisitorBase() {
            @Override
            public void visit(ElementPathBlock elementPathBlock) {
                elementPathBlock.patternElts().forEachRemaining(triplePath -> {
                    if (isUnsafeRecursiveTriplePattern(triplePath)) {
                        unsafe.set(true);
                    }
                });
            }
        });
        return unsafe.get();
    }

    private boolean containsTriplePattern(ClauseEntry[] clauses) {
        for (ClauseEntry clause : clauses) {
            if (clause instanceof TriplePattern) {
                return true;
            }
        }
        return false;
    }

    private Set<String> extractRulePredicates(ClauseEntry[] clauses) {
        Set<String> predicates = new LinkedHashSet<>();
        for (ClauseEntry clause : clauses) {
            if (!(clause instanceof TriplePattern triplePattern)) {
                continue;
            }
            Node predicate = triplePattern.getPredicate();
            if (predicate == null || predicate.isVariable()) {
                continue;
            }
            predicates.add(normalizePredicateNode(predicate));
        }
        return predicates;
    }

    private void collectTableDirectivePredicates(ClauseEntry[] clauses, Set<String> tabledPredicates) {
        for (ClauseEntry clause : clauses) {
            if (!(clause instanceof Functor functor)) {
                continue;
            }
            if (!"table".equals(functor.getName()) || functor.getArgLength() != 1) {
                continue;
            }
            tabledPredicates.add(normalizePredicateNode(functor.getArgs()[0]));
        }
    }

    private boolean containsTableAllDirective(ClauseEntry[] clauses) {
        for (ClauseEntry clause : clauses) {
            if (clause instanceof Functor functor && "tableAll".equals(functor.getName())) {
                return true;
            }
        }
        return false;
    }

    private boolean isUnsafeRecursiveTriplePattern(TriplePath triplePath) {
        Node predicate = triplePath.getPredicate();
        return predicate == null || predicate.isVariable();
    }

    private String normalizePredicateNode(Node predicate) {
        if (predicate != null && predicate.isURI()) {
            return predicate.getURI();
        }
        return predicate == null ? "" : normalizePredicateToken(predicate.toString());
    }

    private String normalizePredicateToken(String token) {
        String normalized = token == null ? "" : token.trim();
        if (normalized.startsWith("<") && normalized.endsWith(">") && normalized.length() >= 2) {
            return normalized.substring(1, normalized.length() - 1);
        }
        return normalized;
    }
}
