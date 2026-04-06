import { readFileSync } from "fs";
import { parse } from "yaml";
import path from "path";

export interface DatasetRules {
  forward: string;
  backward: string;
}

export interface BigQueryConfig {
  enabled: boolean;
  bindingsPath?: string;
}

export interface DatasetConfig {
  id: string;
  label: string;
  description: string;
  /** Optional per-dataset base URI override. Falls back to manifest-level baseUri. */
  baseUri?: string;
  ontologyPath: string;
  rules: DatasetRules;
  fusekiDataset: string;
  bigquery: BigQueryConfig;
}

export interface IriMintingConfig {
  /** Path segment for TBox artifacts: OWL classes, properties, rules. */
  tboxSegment: string;
  /** Path segment for ABox individuals: all data instances regardless of rdf:type. */
  aboxSegment: string;
  /** Any additional segments added in future. Accessed by key. */
  [key: string]: string;
}

export interface DatasetManifest {
  /** Global base URI for IRI minting. Used by all datasets unless overridden. */
  baseUri: string;
  /** IRI segment labels. Controls the path structure for minted IRIs. */
  iriMinting: IriMintingConfig;
  datasets: DatasetConfig[];
}

/**
 * Resolves the effective base URI for a dataset.
 * Dataset-level baseUri takes precedence over the manifest-level default.
 */
export function resolveBaseUri(
  manifest: DatasetManifest,
  dataset: DatasetConfig
): string {
  return dataset.baseUri ?? manifest.baseUri;
}

/**
 * Mints a stable IRI using a segment label looked up from manifest.iriMinting.
 * Pattern: {baseUri}/{segment}/{uuid}
 *
 * The segment is a key into manifest.iriMinting (e.g. "tboxSegment", "aboxSegment",
 * or any future key added to the manifest). No segment values are hardcoded in code.
 *
 * Example:
 *   mintIri(manifest, dataset, "aboxSegment", uuid)
 *   → "https://kg.unconcealment.io/entity/a7f3c291-..."
 */
export function mintIri(
  manifest: DatasetManifest,
  dataset: DatasetConfig,
  segmentKey: string,
  uuid: string
): string {
  const segment = manifest.iriMinting[segmentKey];
  if (!segment) {
    throw new Error(
      `Unknown IRI segment key '${segmentKey}'. ` +
      `Available keys in manifest.iriMinting: ${Object.keys(manifest.iriMinting).join(", ")}`
    );
  }
  const base = resolveBaseUri(manifest, dataset);
  return `${base}/${segment}/${uuid}`;
}

/**
 * Named graph URIs derived from dataset id.
 * Convention: urn:{dataset-id}:{graph-role}
 * Dataset-first ordering ensures globally unique URIs for cross-dataset federation.
 */
export interface NamedGraphs {
  tbox: string;
  rulesForward: string;
  rulesBackward: string;
  aboxAsserted: string;
  aboxInferred: string;
  normalization: string;
  provenance: string;
  systemHealth: string;
}

export function namedGraphs(datasetId: string): NamedGraphs {
  return {
    tbox:          `urn:${datasetId}:tbox:ontology`,
    rulesForward:  `urn:${datasetId}:tbox:rules:forward`,
    rulesBackward: `urn:${datasetId}:tbox:rules:backward`,
    aboxAsserted:  `urn:${datasetId}:abox:asserted`,
    aboxInferred:  `urn:${datasetId}:abox:inferred`,
    normalization: `urn:${datasetId}:normalization`,
    provenance:    `urn:${datasetId}:provenance`,
    systemHealth:  `urn:${datasetId}:system:health`,
  };
}

let _manifest: DatasetManifest | null = null;

/**
 * Loads and caches ontology/manifest.yaml.
 * Path resolved relative to monorepo root, or override with MANIFEST_PATH env var.
 */
export function loadManifest(): DatasetManifest {
  if (_manifest) return _manifest;

  const manifestPath =
    process.env.MANIFEST_PATH ??
    path.resolve(__dirname, "../../../../ontology/manifest.yaml");

  const raw = readFileSync(manifestPath, "utf8");
  _manifest = parse(raw) as DatasetManifest;
  return _manifest;
}

export function getDataset(datasetId: string): DatasetConfig {
  const manifest = loadManifest();
  const dataset = manifest.datasets.find((d) => d.id === datasetId);
  if (!dataset) {
    throw new Error(
      `Dataset '${datasetId}' not found in manifest. Available: ${manifest.datasets.map((d) => d.id).join(", ")}`
    );
  }
  return dataset;
}

/**
 * Convenience: returns the resolved base URI for a dataset by id.
 */
export function getBaseUri(datasetId: string): string {
  const manifest = loadManifest();
  const dataset = getDataset(datasetId);
  return resolveBaseUri(manifest, dataset);
}
