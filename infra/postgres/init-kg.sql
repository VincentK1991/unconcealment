-- Initialize the Knowledge Graph Postgres database
-- Runs once on first container start via docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
