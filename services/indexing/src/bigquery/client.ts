import { BigQuery, Query } from "@google-cloud/bigquery";

let _client: BigQuery | null = null;

/**
 * Returns a singleton BigQuery client.
 *
 * Authentication (in priority order):
 *   1. GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key JSON
 *   2. Application Default Credentials (run: gcloud auth application-default login)
 *
 * GOOGLE_CLOUD_PROJECT must be set — it is the billing project even when
 * querying free public datasets like bigquery-public-data.
 */
export function getBigQueryClient(): BigQuery {
  if (_client) return _client;

  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT env var is required. " +
        "Set it to your GCP project ID (used for billing when querying public datasets)."
    );
  }

  _client = new BigQuery({ projectId });
  return _client;
}

/**
 * Executes a parameterized BigQuery SQL query and returns rows.
 * Params use named syntax: @paramName in SQL, { paramName: value } in params object.
 */
export async function runQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const client = getBigQueryClient();
  const options: Query = {
    query: sql,
    params,
    location: "US",
  };
  const [rows] = await client.query(options);
  return rows as T[];
}
