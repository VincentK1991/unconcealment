package com.unconcealment.backend.controller;

import io.minio.GetObjectArgs;
import io.minio.ListObjectsArgs;
import io.minio.MinioClient;
import io.minio.StatObjectArgs;
import io.minio.messages.Item;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Document gateway for browsing raw source files stored in MinIO.
 * Object key layout mirrors indexing service:
 *   {MINIO_OBJECT_PREFIX}/{datasetId}/{documentKey}/{contentHash}.{ext}
 */
@RestController
@RequestMapping("/document")
public class DocumentController {

    private static final Logger log = LoggerFactory.getLogger(DocumentController.class);

    private static final String DEFAULT_ENDPOINT = "localhost";
    private static final int DEFAULT_PORT = 9000;
    private static final boolean DEFAULT_USE_SSL = false;
    private static final String DEFAULT_ACCESS_KEY = "admin";
    private static final String DEFAULT_SECRET_KEY = "test1234";
    private static final String DEFAULT_BUCKET = "documents";
    private static final String DEFAULT_PREFIX = "raw";

    @GetMapping("/resolve")
    public ResponseEntity<Map<String, Object>> resolve(
            @RequestParam String dataset,
            @RequestParam String documentKey
    ) {
        try {
            ResolvedObject resolved = resolveObject(dataset, documentKey);
            Map<String, Object> body = new HashMap<>();
            body.put("dataset", dataset);
            body.put("documentKey", documentKey);
            body.put("bucket", resolved.bucket);
            body.put("objectKey", resolved.objectKey);
            body.put("contentType", resolved.contentType);
            body.put("viewerUrl", "/document/raw?dataset=" + urlEncode(dataset) + "&documentKey=" + urlEncode(documentKey));
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            log.warn("Document resolve failed for dataset={} key={}: {}", dataset, documentKey, e.getMessage());
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                    "error", "Document not found for dataset/documentKey",
                    "dataset", dataset,
                    "documentKey", documentKey
            ));
        }
    }

    @GetMapping("/raw")
    public ResponseEntity<?> raw(
            @RequestParam String dataset,
            @RequestParam String documentKey
    ) {
        try {
            ResolvedObject resolved = resolveObject(dataset, documentKey);
            MinioClient client = minioClient();
            InputStream stream = client.getObject(
                    GetObjectArgs.builder()
                            .bucket(resolved.bucket)
                            .object(resolved.objectKey)
                            .build()
            );

            MediaType mediaType = parseMediaType(resolved.contentType, resolved.objectKey);
            String fileName = resolved.objectKey.substring(resolved.objectKey.lastIndexOf('/') + 1);

            return ResponseEntity.ok()
                    .contentType(mediaType)
                    .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + fileName + "\"")
                    .body(new InputStreamResource(stream));
        } catch (Exception e) {
            log.warn("Document raw fetch failed for dataset={} key={}: {}", dataset, documentKey, e.getMessage());
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of(
                            "error", "Raw document not found",
                            "dataset", dataset,
                            "documentKey", documentKey
                    ));
        }
    }

    private ResolvedObject resolveObject(String datasetId, String documentKey) throws Exception {
        String bucket = env("MINIO_BUCKET", DEFAULT_BUCKET);
        String prefix = trimSlashes(env("MINIO_OBJECT_PREFIX", DEFAULT_PREFIX));
        String objectPrefix = prefix + "/" + datasetId + "/" + documentKey + "/";

        MinioClient client = minioClient();
        String first = null;
        String pdf = null;
        for (var result : client.listObjects(
                ListObjectsArgs.builder()
                        .bucket(bucket)
                        .prefix(objectPrefix)
                        .recursive(true)
                        .build())) {
            Item item = result.get();
            if (item.isDir()) continue;
            String key = item.objectName();
            if (first == null) first = key;
            if (key.toLowerCase().endsWith(".pdf")) {
                pdf = key;
                break;
            }
        }

        String selectedKey = pdf != null ? pdf : first;
        if (selectedKey == null) {
            throw new IllegalStateException("No object under prefix " + objectPrefix);
        }

        var stat = client.statObject(
                StatObjectArgs.builder()
                        .bucket(bucket)
                        .object(selectedKey)
                        .build()
        );

        return new ResolvedObject(
                bucket,
                selectedKey,
                stat.contentType() != null ? stat.contentType() : guessContentType(selectedKey)
        );
    }

    private MinioClient minioClient() {
        boolean useSsl = env("MINIO_USE_SSL", String.valueOf(DEFAULT_USE_SSL)).equalsIgnoreCase("true");
        return MinioClient.builder()
                .endpoint(env("MINIO_ENDPOINT", DEFAULT_ENDPOINT), Integer.parseInt(env("MINIO_PORT", String.valueOf(DEFAULT_PORT))), useSsl)
                .credentials(
                        env("MINIO_ROOT_USER", DEFAULT_ACCESS_KEY),
                        env("MINIO_ROOT_PASSWORD", DEFAULT_SECRET_KEY)
                )
                .build();
    }

    private String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    private String trimSlashes(String value) {
        return value.replaceAll("^/+", "").replaceAll("/+$", "");
    }

    private MediaType parseMediaType(String contentType, String objectKey) {
        try {
            return MediaType.parseMediaType(contentType);
        } catch (Exception ignored) {
            return MediaType.parseMediaType(guessContentType(objectKey));
        }
    }

    private String guessContentType(String objectKey) {
        String lower = objectKey.toLowerCase();
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private String urlEncode(String value) {
        return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8);
    }

    private record ResolvedObject(
            String bucket,
            String objectKey,
            String contentType
    ) {}
}
