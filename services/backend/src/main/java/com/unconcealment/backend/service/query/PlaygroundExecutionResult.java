package com.unconcealment.backend.service.query;

public record PlaygroundExecutionResult(
        String queryResultsJson,
        String baseResultsJson,
        long baseSize,
        int ruleCount,
        String modeLabel,
        PlaygroundRuleAnalysis ruleAnalysis
) {
}
