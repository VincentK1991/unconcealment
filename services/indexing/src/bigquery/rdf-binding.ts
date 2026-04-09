import { getDataset } from "../config/manifest";

/**
 * R2RML-based semantic binding context builder.
 *
 * Queries the Fuseki backend for R2RML binding metadata stored in
 * urn:{datasetId}:bindings (loaded from a dataset's bindingsPath TTL at startup).
 *
 * This implements the query-time RDF lift strategy described in
 * docs/decisions/semantic-binding.md for datasets using the Turtle R2RML
 * binding format (vs. the legacy YAML format used by economic-census and
 * public-health).
 *
 * SQL template variables in ex:sql values are resolved from manifest config:
 *   {project} → bigquery.project
 *   {dataset} → bigquery.dataset
 *
 * Usage:
 *   // Check which binding format the dataset uses
 *   const hasRdfBindings = datasetHasRdfBindings('insurance');
 *
 *   // Build LLM context string from Fuseki bindings graph
 *   const context = await buildRdfBindingContext('insurance', 'http://localhost:8080');
 */

const R2RML_PREFIXES = `
PREFIX rr:   <http://www.w3.org/ns/r2rml#>
PREFIX ex:   <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
`;

/**
 * SPARQL SELECT query that extracts all TriplesMap metadata from the bindings
 * named graph. Returns one row per (TriplesMap, queryExample) combination —
 * rows with the same ?map but different examples are aggregated by the caller.
 */
function bindingsQuery(datasetId: string): string {
  return `${R2RML_PREFIXES}
SELECT ?map ?label ?description ?dataSource ?joinKey ?exLabel ?exSql
FROM <urn:${datasetId}:bindings>
WHERE {
  ?map a rr:TriplesMap ;
       rdfs:label ?label .
  OPTIONAL { ?map rdfs:comment ?description }
  OPTIONAL { ?map ex:dataSource ?dataSource }
  OPTIONAL { ?map ex:joinKey ?joinKey }
  OPTIONAL {
    ?map ex:queryExample ?ex .
    ?ex rdfs:label ?exLabel ;
        ex:sql ?exSql .
  }
}
ORDER BY ?map ?exLabel
`;
}

interface BindingRow {
  map: { value: string };
  label: { value: string };
  description?: { value: string };
  dataSource?: { value: string };
  joinKey?: { value: string };
  exLabel?: { value: string };
  exSql?: { value: string };
}

interface SparqlResults {
  results: { bindings: BindingRow[] };
}

/**
 * Returns true if the dataset is configured with a Turtle R2RML bindingsPath
 * (as opposed to the legacy YAML bigquery.bindingsPath format).
 */
export function datasetHasRdfBindings(datasetId: string): boolean {
  try {
    const dataset = getDataset(datasetId);
    // The manifest TypeScript interface uses the same field name as the Java model.
    // Cast to any to access the field introduced in the insurance domain.
    return !!(dataset as any).bindingsPath;
  } catch {
    return false;
  }
}

/**
 * Resolves {project} and {dataset} template variables in a SQL string
 * using the manifest's bigquery config for the given dataset.
 */
function resolveTemplates(sql: string, datasetId: string): string {
  const dataset = getDataset(datasetId);
  const bq = dataset.bigquery as any;
  if (!bq) return sql;
  return sql
    .replace(/\{project\}/g, bq.project ?? "{project}")
    .replace(/\{dataset\}/g, bq.dataset ?? "{dataset}");
}

/**
 * Fetches R2RML binding metadata from Fuseki and returns a formatted
 * context string for LLM prompt injection.
 *
 * @param datasetId  Dataset identifier (e.g. "insurance")
 * @param backendUrl Java backend base URL (e.g. "http://localhost:8080")
 */
export async function buildRdfBindingContext(
  datasetId: string,
  backendUrl: string
): Promise<string> {
  const query = bindingsQuery(datasetId);

  const response = await fetch(`${backendUrl}/query/tbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      Accept: "application/sparql-results+json",
    },
    body: query,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch R2RML bindings for dataset '${datasetId}': ` +
        `${response.status} ${response.statusText}`
    );
  }

  const results = (await response.json()) as SparqlResults;
  const rows = results.results.bindings;

  if (rows.length === 0) {
    return "";
  }

  // Group rows by TriplesMap IRI, collecting multiple query examples per map
  const maps = new Map<
    string,
    {
      label: string;
      description?: string;
      dataSource?: string;
      joinKey?: string;
      examples: Array<{ label: string; sql: string }>;
    }
  >();

  for (const row of rows) {
    const mapIri = row.map.value;
    if (!maps.has(mapIri)) {
      maps.set(mapIri, {
        label: row.label.value,
        description: row.description?.value,
        dataSource: row.dataSource?.value,
        joinKey: row.joinKey?.value,
        examples: [],
      });
    }
    if (row.exLabel && row.exSql) {
      const entry = maps.get(mapIri)!;
      const resolvedSql = resolveTemplates(row.exSql.value, datasetId);
      // Deduplicate examples with identical labels
      if (!entry.examples.some((e) => e.label === row.exLabel!.value)) {
        entry.examples.push({ label: row.exLabel.value, sql: resolvedSql });
      }
    }
  }

  // Build human-readable context string for LLM
  const bq = (getDataset(datasetId) as any).bigquery;
  const projectLabel = bq?.project ?? "YOUR_GCP_PROJECT";
  const datasetLabel = bq?.dataset ?? "YOUR_DATASET";

  const lines: string[] = [
    `Available tables (BigQuery project: ${projectLabel}, dataset: ${datasetLabel}):`,
    "",
  ];

  for (const [, entry] of maps) {
    lines.push(`## ${entry.label}`);
    if (entry.description) {
      lines.push(entry.description.trim());
    }
    if (entry.joinKey) {
      lines.push(`Join key: ${entry.joinKey}`);
    }
    if (entry.examples.length > 0) {
      lines.push("Example queries:");
      for (const ex of entry.examples) {
        lines.push(`  # ${ex.label}`);
        lines.push("  ```sql");
        for (const sqlLine of ex.sql.trim().split("\n")) {
          lines.push(`  ${sqlLine}`);
        }
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
