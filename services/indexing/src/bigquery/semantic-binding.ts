import { readFileSync } from "fs";
import { parse } from "yaml";
import path from "path";
import { getDataset } from "../config/manifest";

interface TableBinding {
  id: string;
  dataset: string;
  table: string;
  description: string;
  keyColumns: Array<{ name: string; type: string; description: string }>;
  queryExamples: Array<{ intent: string; sql: string }>;
}

interface BigQueryBindings {
  project: string;
  tables: TableBinding[];
}

/**
 * Loads the BigQuery semantic binding file for a given dataset.
 * Returns the table schemas and query examples that will be provided
 * to the LLM at query time to enable query-time RDF lift.
 *
 * This is a virtual binding layer — no data is copied into the triplestore.
 * The LLM generates SQL from the metadata provided here.
 */
export function loadBindings(datasetId: string): BigQueryBindings | null {
  const dataset = getDataset(datasetId);
  if (!dataset.bigquery?.enabled || !dataset.bigquery.bindingsPath) {
    return null;
  }

  const bindingsPath = path.resolve(
    process.env.REPO_ROOT ?? path.resolve(__dirname, "../../../.."),
    dataset.bigquery.bindingsPath
  );

  const raw = readFileSync(bindingsPath, "utf8");
  return parse(raw) as BigQueryBindings;
}

/**
 * Builds a prompt context string describing available BigQuery tables
 * for a given dataset. This string is appended to LLM prompts at query time.
 *
 * TODO (Phase 2): integrate with MCP tool for query-time RDF lift.
 */
export function buildBindingContext(datasetId: string): string {
  const bindings = loadBindings(datasetId);
  if (!bindings) return "";

  const lines: string[] = [
    `Available BigQuery tables (project: ${bindings.project}):`,
    "",
  ];

  for (const table of bindings.tables) {
    lines.push(`## ${table.id}: ${table.description}`);
    lines.push(`Table: \`${bindings.project}.${table.dataset}.${table.table}\``);
    lines.push("Columns:");
    for (const col of table.keyColumns) {
      lines.push(`  - ${col.name} (${col.type}): ${col.description}`);
    }
    if (table.queryExamples.length > 0) {
      lines.push("Example query:");
      lines.push("```sql");
      lines.push(table.queryExamples[0].sql.trim());
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}
