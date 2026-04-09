import type { APIRoute } from "astro";
import { readFileSync } from "fs";
import { parse } from "yaml";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

export const prerender = false;

// ── Manifest loading ──────────────────────────────────────────────────────────

interface ManifestDataset {
  id: string;
  postgres?: { enabled?: boolean; schema?: string };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath =
  process.env.MANIFEST_PATH ??
  path.resolve(__dirname, "../../../../../ontology/manifest.yaml");

function getPostgresConfig(
  datasetId: string
): { schema: string } | null {
  const manifest = parse(readFileSync(manifestPath, "utf8")) as {
    datasets: ManifestDataset[];
  };
  const dataset = manifest.datasets.find((d) => d.id === datasetId);
  if (!dataset?.postgres?.enabled || !dataset.postgres.schema) return null;
  return { schema: dataset.postgres.schema };
}

// ── Connection pool ───────────────────────────────────────────────────────────
// One pool per process; pg handles reconnects automatically.

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host:     process.env.POSTGRES_KG_HOST     ?? "localhost",
    port:     Number(process.env.POSTGRES_KG_PORT ?? 5432),
    database: process.env.POSTGRES_KG_DB       ?? "kg",
    user:     process.env.POSTGRES_KG_USER     ?? "kg",
    password: process.env.POSTGRES_KG_PASSWORD ?? "",
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ params, request }) => {
  const { dataset } = params;
  if (!dataset) {
    return new Response(JSON.stringify({ error: "Missing dataset" }), { status: 400 });
  }

  // Validate dataset has postgres enabled
  let pgConfig: { schema: string };
  try {
    const cfg = getPostgresConfig(dataset);
    if (!cfg) {
      return new Response(
        JSON.stringify({ error: `Dataset '${dataset}' does not have PostgreSQL enabled` }),
        { status: 400 }
      );
    }
    pgConfig = cfg;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Manifest error: ${e instanceof Error ? e.message : String(e)}` }),
      { status: 500 }
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).sql !== "string"
  ) {
    return new Response(
      JSON.stringify({ error: "Body must be { sql: string }" }),
      { status: 400 }
    );
  }

  const rawSql = ((body as Record<string, unknown>).sql as string).trim();

  // SELECT-only guard
  if (!/^select\b/i.test(rawSql)) {
    return new Response(
      JSON.stringify({ error: "Only SELECT statements are permitted" }),
      { status: 400 }
    );
  }

  // Execute
  const client = await getPool().connect();
  try {
    // Set search path to the dataset's schema so unqualified table names work.
    await client.query(`SET search_path TO ${pgConfig.schema}, public`);

    // Inject LIMIT 500 if the query has no LIMIT clause.
    const hasLimit = /\blimit\s+\d+/i.test(rawSql);
    const execSql = hasLimit ? rawSql : `${rawSql}\nLIMIT 500`;

    const result = await client.query(execSql);

    const columns = result.fields.map((f) => f.name);
    const rows = result.rows as Record<string, unknown>[];

    return new Response(JSON.stringify({ columns, rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), { status: 400 });
  } finally {
    client.release();
  }
};
