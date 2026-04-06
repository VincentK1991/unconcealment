# unconcealment — task runner
# Install: brew install just
# Usage:   just <recipe>

set dotenv-load := true   # load .env from repo root if present

BACKEND_DIR  := "services/backend"
INDEXING_DIR := "services/indexing"

# Default: list available recipes
default:
    @just --list

# ─── Infrastructure ───────────────────────────────────────────────────────────

# Start all Docker infrastructure (Fuseki, Temporal, Postgres)
infra-up:
    docker compose up -d
    @echo "Fuseki UI:    http://localhost:3030"
    @echo "Temporal UI:  http://localhost:8088"
    @echo "Postgres KG:  localhost:5433 (db=kg, user=admin)"

# Stop all Docker infrastructure
infra-down:
    docker compose down

# Show infrastructure logs
infra-logs:
    docker compose logs -f

# ─── Backend ──────────────────────────────────────────────────────────────────

# Start the Java backend (loads ontologies into Fuseki at startup)
# Runs from repo root so ontology/manifest.yaml resolves correctly.
backend:
    cd {{BACKEND_DIR}} && mvn spring-boot:run \
        -Dspring-boot.run.jvmArguments="-Xmx1g" \
        -Dspring-boot.run.workingDirectory="{{justfile_directory()}}"

# Build the backend JAR without running tests
backend-build:
    cd {{BACKEND_DIR}} && mvn package -DskipTests

# Run backend tests
backend-test:
    cd {{BACKEND_DIR}} && mvn test

# Reload ontologies for a dataset without restarting the backend
# Usage: just reload economic-census
reload dataset:
    curl -s -X POST "http://localhost:8080/query/admin/reload?dataset={{dataset}}" | jq .

# ─── Indexing Worker ──────────────────────────────────────────────────────────

# Install indexing dependencies
indexing-install:
    cd {{INDEXING_DIR}} && npm install

# Apply Prisma migrations to the KG Postgres database
indexing-migrate:
    cd {{INDEXING_DIR}} && DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        npx prisma migrate dev --name init

# Generate Prisma client after schema changes
indexing-generate:
    cd {{INDEXING_DIR}} && npx prisma generate

# Start the Temporal indexing worker
# Requires: OPENAI_API_KEY env var (set in .env or export before running)
worker:
    cd {{INDEXING_DIR}} && \
        DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        TEMPORAL_ADDRESS="localhost:7233" \
        BACKEND_URL="http://localhost:8080" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        npx ts-node src/worker.ts

# ─── Integration Test ─────────────────────────────────────────────────────────

# Fire one test document through the full pipeline
# Usage: just trigger
# Usage: just trigger economic-census
trigger dataset="economic-census":
    cd {{INDEXING_DIR}} && \
        DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        TEMPORAL_ADDRESS="localhost:7233" \
        BACKEND_URL="http://localhost:8080" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        DATASET_ID="{{dataset}}" \
        npx ts-node src/scripts/triggerDocument.ts

# ─── Web UI ───────────────────────────────────────────────────────────────────

# Start the Astro web UI dev server
web:
    cd services/web && \
        BACKEND_URL="http://localhost:8080" \
        BASE_URI="http://localhost:8080" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        npm run dev

# ─── Health checks ────────────────────────────────────────────────────────────

# Check backend health
health:
    @echo "=== /health/live ==="
    @curl -s http://localhost:8080/health/live | jq .
    @echo ""
    @echo "=== /health/ready ==="
    @curl -s http://localhost:8080/health/ready | jq .

# Show triple counts per dataset
metrics:
    @curl -s http://localhost:8080/health/metrics | jq .

# ─── Shortcuts ────────────────────────────────────────────────────────────────

# Start everything needed for local dev (infra + backend + worker) in parallel
# Note: each process prints to its own terminal. Use tmux or split panes.
dev:
    @echo "Start each service in a separate terminal:"
    @echo ""
    @echo "  Terminal 1:  just infra-up"
    @echo "  Terminal 2:  just backend"
    @echo "  Terminal 3:  just worker"
    @echo "  Terminal 4:  just web"
    @echo ""
    @echo "Then test with:  just trigger"
