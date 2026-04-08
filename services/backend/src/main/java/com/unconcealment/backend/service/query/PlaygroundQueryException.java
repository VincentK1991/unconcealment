package com.unconcealment.backend.service.query;

import org.springframework.http.HttpStatus;

public class PlaygroundQueryException extends RuntimeException {

    private final HttpStatus status;

    public PlaygroundQueryException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus status() {
        return status;
    }
}
