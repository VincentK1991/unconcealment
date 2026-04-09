import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { ApplicationFailure } from "@temporalio/common";
import { PrismaClient } from "@prisma/client";
import { getDataset } from "../config/manifest";
import {
  buildExtractionSystemPrompt,
  PIPELINE_CONSTANTS,
  SPARQL_ONTOLOGY_CONTEXT_QUERY,
} from "../constants/pipeline";

const prisma = new PrismaClient();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AttributeSchema = z.object({
  predicate: z.string().describe("Ontology property local name (e.g. 'foundedIn')"),
  value:     z.string().describe("Scalar literal value (date, number, text)"),
});

const EntitySchema = z.object({
  label:       z.string().describe("Human-readable entity label (e.g. 'Apple Inc.')"),
  type:        z.string().describe("Ontology class local name (e.g. 'Organization')"),
  description: z.string().describe("1-3 sentence factual summary of this entity drawn directly from the text; empty string if insufficient context"),
  attributes:  z.array(AttributeSchema).describe("Scalar facts intrinsic to this entity (dates, identifiers, amounts) — do NOT duplicate facts already expressed as inter-entity relationships"),
});

const RelationshipSchema = z.object({
  subjectId:       z.number().int().describe("0-based index of the subject entity in the entities array"),
  predicate:       z.string().describe("Ontology property local name (e.g. 'hasEmployer')"),
  objectId:        z.number().int().nullable().describe("0-based index of the object entity; null if objectIsLiteral is true"),
  objectLiteral:   z.string().nullable().describe("Literal value (date, number, text); null if objectIsLiteral is false"),
  objectIsLiteral: z.boolean().describe("True if object is a literal; false if object is a named entity"),
  confidence:      z.number().min(0).max(1).describe("Extraction confidence [0-1]"),
});

const ExtractionResultSchema = z.object({
  entities:      z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
});

export type ExtractionAttribute  = z.infer<typeof AttributeSchema>;
export type ExtractionEntity     = z.infer<typeof EntitySchema>;
export type ExtractionRelationship = z.infer<typeof RelationshipSchema>;

export interface ExtractEntitiesFromChunkInput {
  datasetId:    string;
  documentIri:  string;
  chunkId:      string;
}

export interface ExtractEntitiesOutput {
  entities:      ExtractionEntity[];
  relationships: ExtractionRelationship[];
}

interface OntologyBinding {
  term:         { value: string };
  termType:     { value: string };
  label?:       { value: string };
  comment?:     { value: string };
  propertyKind?: { value: string };
  domains?:     { value: string };
  ranges?:      { value: string };
}

/**
 * Activity: extract entities and relationships from a single document chunk.
 *
 * Reads chunk text from the database by chunkId (written by embedAndStore).
 * Ontology context (classes + properties) is fetched live from the graph via POST /query/tbox.
 * The LLM outputs entity labels and ontology local names — no IRIs. IRI minting and entity
 * deduplication (upsert by label+type) are delegated to the Java backend (assertToGraph).
 *
 * The workflow fans out one of these activities per chunk, collects all results, re-offsets
 * relationship indices to a flat entity array, then calls assertToGraph once.
 */
export async function extractEntitiesFromChunk(
  input: ExtractEntitiesFromChunkInput
): Promise<ExtractEntitiesOutput> {
  const dataset = getDataset(input.datasetId);
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";

  const chunk = await prisma.documentChunk.findUnique({
    where:  { id: input.chunkId },
    select: { chunkText: true },
  });
  if (!chunk) {
    throw ApplicationFailure.nonRetryable(
      `Chunk ${input.chunkId} not found in database`,
      "NonRetryableExtractionChunkNotFoundError"
    );
  }

  const { classes, properties } = await fetchOntologyContext(backendUrl, input.datasetId, dataset.label);
  const systemPrompt = buildExtractionSystemPrompt(classes, properties);

  try {
    return await callStructuredExtraction(systemPrompt, chunk.chunkText);
  } catch (firstError) {
    // Only apply the "retry with error context" prompt for schema/validation failures.
    // Transient errors (rate limits, network) should be re-thrown so Temporal retries cleanly.
    if (!isValidationError(firstError)) {
      throw firstError;
    }

    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    try {
      return await callStructuredExtraction(
        systemPrompt,
        `The previous extraction returned invalid output: ${reason}\n\nExtract entities and relationships from:\n\n${chunk.chunkText}`
      );
    } catch (retryError) {
      const retryMessage =
        retryError instanceof Error ? retryError.message : String(retryError);
      throw ApplicationFailure.nonRetryable(
        `Extraction schema validation failed after schema-context retry: ${retryMessage}`,
        "NonRetryableExtractionSchemaError"
      );
    }
  }
}

/**
 * Returns true when the error is a local schema/validation problem (bad model output)
 * rather than a transient API error. Only validation errors trigger the prompt-with-context retry.
 */
function isValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("no parsed") ||
    msg.includes("invalid subjectid") ||
    msg.includes("invalid objectid") ||
    msg.includes("schema") ||
    msg.includes("parse error")
  );
}

async function fetchOntologyContext(
  backendUrl: string,
  datasetId: string,
  datasetLabel: string
): Promise<{ classes: string; properties: string }> {
  const fallback = {
    classes:    `  (no ontology classes found — dataset: ${datasetLabel})`,
    properties: `  (no ontology properties found — dataset: ${datasetLabel})`,
  };

  try {
    const res = await fetch(`${backendUrl}/query/tbox?dataset=${encodeURIComponent(datasetId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/sparql-query" },
      body: SPARQL_ONTOLOGY_CONTEXT_QUERY,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as {
      results?: { bindings?: OntologyBinding[] };
    };

    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) {
      return fallback;
    }

    const classLines: string[] = [];
    const propertyLines: string[] = [];

    for (const row of bindings) {
      const localName = extractLocalName(row.term.value);
      const label = row.label?.value ?? localName;
      const comment = row.comment?.value ? ` — ${row.comment.value}` : "";
      if (row.termType.value === "class") {
        classLines.push(`  ${localName} (${label})${comment}`);
      } else {
        const propertyKind = row.propertyKind?.value ? `${row.propertyKind.value} property` : "property";
        const domains = formatIriList(row.domains?.value);
        const ranges = formatIriList(row.ranges?.value);
        const signatureParts = [propertyKind];
        if (domains) signatureParts.push(`domain=${domains}`);
        if (ranges) signatureParts.push(`range=${ranges}`);
        propertyLines.push(`  ${localName} (${label}) [${signatureParts.join("; ")}]${comment}`);
      }
    }

    return {
      classes:    classLines.length > 0 ? classLines.join("\n") : fallback.classes,
      properties: propertyLines.length > 0 ? propertyLines.join("\n") : fallback.properties,
    };
  } catch (err) {
    console.warn(
      `[extractEntities] Could not fetch ontology for dataset '${datasetId}': ${err}. Using placeholder.`
    );
    return fallback;
  }
}

function extractLocalName(iri: string): string {
  return iri.replace(/.*[#/]/, "");
}

function formatIriList(value?: string): string {
  if (!value) return "";
  const items = value
    .split("|")
    .map(item => item.trim())
    .filter(Boolean)
    .map(extractLocalName);
  return [...new Set(items)].join(", ");
}

async function callStructuredExtraction(
  systemPrompt: string,
  userContent: string
): Promise<ExtractEntitiesOutput> {
  const response = await openai.responses.parse({
    model: PIPELINE_CONSTANTS.models.extraction,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: `Extract entities and relationships from the following text:\n\n${userContent}` },
    ],
    text: {
      format: zodTextFormat(ExtractionResultSchema, "extraction_result"),
    },
  });

  const parsed = response.output_parsed;
  if (!parsed) {
    throw new Error("No parsed extraction payload returned by model");
  }

  // Validate that all entity indices in relationships are in range
  const entityCount = parsed.entities.length;
  for (const rel of parsed.relationships) {
    if (rel.subjectId < 0 || rel.subjectId >= entityCount) {
      throw new Error(`Invalid subjectId ${rel.subjectId} (entities length: ${entityCount})`);
    }
    if (!rel.objectIsLiteral) {
      if (rel.objectId === null || rel.objectId === undefined || rel.objectId < 0 || rel.objectId >= entityCount) {
        throw new Error(`Invalid objectId ${rel.objectId} (entities length: ${entityCount})`);
      }
    }
  }

  return parsed;
}
