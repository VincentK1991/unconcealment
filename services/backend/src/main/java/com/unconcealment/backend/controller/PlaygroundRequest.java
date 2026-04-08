package com.unconcealment.backend.controller;

/**
 * Request body for POST /query/playground.
 * Both fields are plain strings sent as application/json.
 */
public record PlaygroundRequest(String rules, String query) {}
