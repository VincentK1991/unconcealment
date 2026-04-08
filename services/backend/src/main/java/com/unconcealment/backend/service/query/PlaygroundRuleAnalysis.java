package com.unconcealment.backend.service.query;

import java.util.LinkedHashSet;
import java.util.Set;

public record PlaygroundRuleAnalysis(
        boolean hasBackwardRules,
        boolean hasForwardRules,
        boolean tableAll,
        Set<String> recursivePredicates,
        Set<String> tabledPredicates
) {
    public boolean hasRecursiveRules() {
        return !recursivePredicates.isEmpty();
    }

    public boolean allRecursivePredicatesTabled() {
        return tableAll || tabledPredicates.containsAll(recursivePredicates);
    }

    public Set<String> untabledRecursivePredicates() {
        if (tableAll) {
            return Set.of();
        }
        Set<String> missing = new LinkedHashSet<>(recursivePredicates);
        missing.removeAll(tabledPredicates);
        return Set.copyOf(missing);
    }
}
