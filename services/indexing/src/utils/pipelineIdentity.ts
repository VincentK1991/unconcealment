import { createHash } from "crypto";
import { getBaseUri, getDataset, loadManifest, mintIri } from "../config/manifest";

export interface DeterministicIdentityInput {
  datasetId: string;
  sourceUrl: string;
  sourcePath?: string;
  externalDocumentId?: string;
}

function normalizeSource(input: DeterministicIdentityInput): string {
  return [
    input.datasetId.trim(),
    input.externalDocumentId?.trim() ?? "",
    input.sourcePath?.trim() ?? "",
    input.sourceUrl.trim(),
  ].join("|");
}

export function buildDeterministicDocumentKey(input: DeterministicIdentityInput): string {
  const normalized = normalizeSource(input);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function buildDeterministicWorkflowId(input: DeterministicIdentityInput): string {
  const key = buildDeterministicDocumentKey(input);
  return `index-doc-${input.datasetId}-${key}`;
}

export function buildDeterministicDocumentIri(input: DeterministicIdentityInput): string {
  const manifest = loadManifest();
  const dataset = getDataset(input.datasetId);
  const key = buildDeterministicDocumentKey(input);
  return mintIri(manifest, dataset, "documentSegment", key);
}

export function buildDeterministicIdentity(input: DeterministicIdentityInput): {
  documentKey: string;
  workflowId: string;
  documentIri: string;
  baseUri: string;
} {
  const documentKey = buildDeterministicDocumentKey(input);
  return {
    documentKey,
    workflowId: buildDeterministicWorkflowId(input),
    documentIri: buildDeterministicDocumentIri(input),
    baseUri: getBaseUri(input.datasetId),
  };
}
