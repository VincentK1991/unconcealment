# unconcealment

A metadata-driven knowledge graph system for semantic integration across unstructured documents and structured data (Google BigQuery).

## Architecture

```
unconcealment/
├── services/
│   ├── backend/      Java 21 + Spring Boot — SPARQL gateway, hybrid reasoning, Fuseki management
│   ├── indexing/     Node.js + TypeScript — Temporal workers, LLM extraction, Prisma/pgvector
│   └── web/          Astro + React — Wikipedia-style entity browser, MCP/CLI interface
├── ontology/
│   ├── manifest.yaml — dataset registry; drives all runtime behavior (no hardcoded domains)
│   ├── economic-census/
│   └── public-health/
├── infra/
│   └── fuseki/       Apache Jena Fuseki config (TDB2 + Jena-text)
└── docker-compose.yml
```

## Quickstart

### Prerequisites
- Docker & Docker Compose
- Java 21 (`sdk install java 21-tem`)
- Node.js 20 LTS
- GCP project ID (for BigQuery public dataset queries)

### 1. Copy environment config
```bash
cp .env.example .env
# Edit .env: set GOOGLE_CLOUD_PROJECT and OPENAI_API_KEY
```

### 2. Start infrastructure
```bash
docker compose up -d
# Fuseki UI:    http://localhost:3030
# Temporal UI:  http://localhost:8088
```

### 3. Start backend
```bash
cd services/backend
./mvnw spring-boot:run
# Health: http://localhost:8080/health/live
```

### 4. Start indexing worker
```bash
cd services/indexing
npm install
npm run worker
```

### 5. Start web server
```bash
cd services/web
npm install
npm run dev
# UI: http://localhost:4321
```

### 6. Test BigQuery connectivity
```bash
cd services/indexing
npx ts-node src/bigquery/probe.ts
```

## Design

See [`docs/decisions/project_profile.md`](docs/decisions/project_profile.md) for the full architecture design document.

## Key Principles

- **Metadata-driven**: adding a new dataset = add one block to `ontology/manifest.yaml` + create ontology folder. No code changes.
- **Continuous graph lifecycle**: entities are stable; retraction over deletion; never nuke and rebuild.
- **Hybrid reasoning**: forward chaining (materialized) + backward chaining (query-time) via Apache Jena.
- **RDF-star provenance**: every asserted triple carries source document, confidence, and bi-temporal annotations.
