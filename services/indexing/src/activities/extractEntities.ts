import OpenAI from "openai";
import { z } from "zod";
import { getDataset } from "../config/manifest";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// RDF triple with RDF-star provenance metadata
const RdfTripleSchema = z.object({
  subject: z.string().describe("IRI of the subject entity"),
  predicate: z.string().describe("IRI of the predicate (from the ontology)"),
  object: z.string().describe("IRI or literal value of the object"),
  objectIsLiteral: z.boolean().describe("True if object is a literal value"),
  confidence: z.number().min(0).max(1).describe("Extraction confidence [0-1]"),
});

const ExtractionResultSchema = z.object({
  triples: z.array(RdfTripleSchema),
});

export type RdfTriple = z.infer<typeof RdfTripleSchema>;

export interface ExtractEntitiesInput {
  datasetId: string;
  documentIri: string;
  text: string;
  chunkIds: string[];
}

export interface ExtractEntitiesOutput {
  triples: RdfTriple[];
}

/**
 * Activity: extract RDF triples from document text using GPT-4o.
 * Ontology context is fetched from the graph (TODO: Phase 1 — query urn:tbox:ontology:{datasetId})
 * and appended to the prompt. Extraction is constrained by a Zod schema.
 *
 * The datasetId parameter drives which ontology is used — nothing is hardcoded.
 */
export async function extractEntities(
  input: ExtractEntitiesInput
): Promise<ExtractEntitiesOutput> {
  const dataset = getDataset(input.datasetId);

  // TODO (Phase 1): fetch live ontology from urn:tbox:ontology:{datasetId} via SPARQL
  // For now, use the dataset label as a placeholder in the prompt
  const ontologyContext = `Dataset: ${dataset.label}\nOntology: ${dataset.ontologyPath} (load from graph at Phase 1 impl)`;

  const systemPrompt = `You are a knowledge graph extraction engine.
Extract RDF triples from the provided text using the ontology below.
Return only triples that are explicitly supported by the text.
Use full IRIs for subjects, predicates, and object IRIs.
For literals, use the raw value string.

${ontologyContext}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Extract RDF triples from the following text:\n\n${input.text}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  const parsed = ExtractionResultSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `GPT-4o returned malformed extraction result: ${parsed.error.message}`
    );
  }

  return parsed.data;
}
