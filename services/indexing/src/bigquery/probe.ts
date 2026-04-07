/**
 * BigQuery connectivity probe.
 * Queries a public census dataset to validate that:
 *   - GOOGLE_CLOUD_PROJECT is set correctly
 *   - Authentication (ADC or service account) is working
 *   - The public dataset is reachable
 *
 * Run: npx ts-node src/bigquery/probe.ts
 */
import { runQuery } from "./client";

async function probe(): Promise<void> {
  console.log("Probing BigQuery public census dataset...");
  console.log(`GCP project: ${process.env.GOOGLE_CLOUD_PROJECT ?? "(not set)"}`);

  const sql = `
    SELECT geo_id, total_pop, median_income
    FROM \`bigquery-public-data.census_bureau_acs.county_2020_5yr\`
    WHERE total_pop > 0
    ORDER BY total_pop DESC
    LIMIT 5
  `;

  try {
    const rows = await runQuery(sql);
    console.log(`\nSuccess — top 5 counties by population:\n`);
    console.table(
      rows.map((r) => ({
        geo_id: String(r.geo_id),
        total_pop: Number(r.total_pop).toLocaleString(),
        median_income:
          r.median_income == null
            ? "N/A"
            : `$${Number(r.median_income).toLocaleString()}`,
      }))
    );
    console.log(
      "\nBigQuery connection is working. Semantic binding layer is ready to scaffold."
    );
  } catch (err) {
    console.error("\nBigQuery probe failed:", err);
    console.error(
      "\nTroubleshooting:\n" +
        "  1. Set GOOGLE_CLOUD_PROJECT to your GCP project ID\n" +
        "  2. Run: gcloud auth application-default login\n" +
        "     OR set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON path"
    );
    process.exit(1);
  }
}

probe();
