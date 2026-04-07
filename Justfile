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
    @echo "MinIO API:    http://localhost:9000"
    @echo "MinIO UI:     http://localhost:9001"

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

# One-command local migration workflow.
# - Applies/creates migrations
# - If drift blocks migrate dev, auto-resets DB and retries
# Usage: just indexing-migrate
# Usage: just indexing-migrate add_documents_and_chunk_fk
indexing-migrate name="local_schema_update":
    cd {{INDEXING_DIR}} && DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        sh -c 'npx prisma migrate dev --name {{name}} || (echo "migrate dev failed; resetting local DB and retrying..." && npx prisma migrate reset --force --skip-seed && npx prisma migrate dev --name {{name}})'

# Apply committed migrations only (recommended for CI/prod)
indexing-migrate-deploy:
    cd {{INDEXING_DIR}} && DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        npx prisma migrate deploy

# Generate Prisma client after schema changes
indexing-generate:
    cd {{INDEXING_DIR}} && npx prisma generate

# Open Prisma Studio to inspect KG Postgres data
indexing-studio:
    cd {{INDEXING_DIR}} && DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        npx prisma studio

# Start the Temporal indexing worker
# Requires: OPENAI_API_KEY env var (set in .env or export before running)
worker:
    cd {{INDEXING_DIR}} && \
        DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        TEMPORAL_ADDRESS="localhost:7233" \
        BACKEND_URL="http://localhost:8080" \
        MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}" \
        MINIO_PORT="${MINIO_PORT:-9000}" \
        MINIO_USE_SSL="${MINIO_USE_SSL:-false}" \
        MINIO_ROOT_USER="${MINIO_ROOT_USER:-admin}" \
        MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-test1234}" \
        MINIO_BUCKET="${MINIO_BUCKET:-documents}" \
        MINIO_OBJECT_PREFIX="${MINIO_OBJECT_PREFIX:-raw}" \
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
        MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}" \
        MINIO_PORT="${MINIO_PORT:-9000}" \
        MINIO_USE_SSL="${MINIO_USE_SSL:-false}" \
        MINIO_ROOT_USER="${MINIO_ROOT_USER:-admin}" \
        MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-test1234}" \
        MINIO_BUCKET="${MINIO_BUCKET:-documents}" \
        MINIO_OBJECT_PREFIX="${MINIO_OBJECT_PREFIX:-raw}" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        DATASET_ID="{{dataset}}" \
        npx ts-node src/scripts/triggerDocument.ts

# Index one PDF or all PDFs in a directory with bounded Temporal in-flight workflows
# Usage: just index-pdfs data/economic-census
# Usage: just index-pdfs data/economic-census economic-census 2 "" 3   (offset=3, no limit)
# Usage: just index-pdfs data/economic-census economic-census 2 5  3   (offset=3, limit=5)
index-pdfs input_path dataset="" max_in_flight="2" limit="" offset="":
    cd {{INDEXING_DIR}} && \
        DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        TEMPORAL_ADDRESS="localhost:7233" \
        BACKEND_URL="http://localhost:8080" \
        MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}" \
        MINIO_PORT="${MINIO_PORT:-9000}" \
        MINIO_USE_SSL="${MINIO_USE_SSL:-false}" \
        MINIO_ROOT_USER="${MINIO_ROOT_USER:-admin}" \
        MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-test1234}" \
        MINIO_BUCKET="${MINIO_BUCKET:-documents}" \
        MINIO_OBJECT_PREFIX="${MINIO_OBJECT_PREFIX:-raw}" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        sh -c 'cmd="npx ts-node src/scripts/indexPdfs.ts \"{{justfile_directory()}}/{{input_path}}\" --max-in-flight \"{{max_in_flight}}\""; if [ -n "{{dataset}}" ]; then cmd="$cmd --dataset \"{{dataset}}\""; fi; if [ -n "{{offset}}" ]; then cmd="$cmd --offset \"{{offset}}\""; fi; if [ -n "{{limit}}" ]; then cmd="$cmd --limit \"{{limit}}\""; fi; eval "$cmd"'

# Remove one document from graph + Postgres + MinIO using the cleanup workflow
# Usage: just cleanup economic-census
cleanup dataset="economic-census":
    cd {{INDEXING_DIR}} && \
        DATABASE_URL="postgresql://admin:test1234@localhost:5433/kg" \
        TEMPORAL_ADDRESS="localhost:7233" \
        BACKEND_URL="http://localhost:8080" \
        MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}" \
        MINIO_PORT="${MINIO_PORT:-9000}" \
        MINIO_USE_SSL="${MINIO_USE_SSL:-false}" \
        MINIO_ROOT_USER="${MINIO_ROOT_USER:-admin}" \
        MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-test1234}" \
        MINIO_BUCKET="${MINIO_BUCKET:-documents}" \
        MINIO_OBJECT_PREFIX="${MINIO_OBJECT_PREFIX:-raw}" \
        MANIFEST_PATH="{{justfile_directory()}}/ontology/manifest.yaml" \
        DATASET_ID="{{dataset}}" \
        npx ts-node src/scripts/cleanupDocument.ts

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

# Clear asserted + normalization graphs for a dataset (use before reindexing)
# Usage: just clear-graph economic-census
# Usage: just clear-graph public-health
clear-graph dataset:
    @echo "Clearing abox:asserted for dataset '{{dataset}}'..."
    curl -sf -X POST "http://localhost:8080/query/update?dataset={{dataset}}" \
        -H "Content-Type: application/sparql-update" \
        --data-binary "CLEAR SILENT GRAPH <urn:{{dataset}}:abox:asserted>"
    @echo "Clearing normalization for dataset '{{dataset}}'..."
    curl -sf -X POST "http://localhost:8080/query/update?dataset={{dataset}}" \
        -H "Content-Type: application/sparql-update" \
        --data-binary "CLEAR SILENT GRAPH <urn:{{dataset}}:normalization>"
    @echo "Done."

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
