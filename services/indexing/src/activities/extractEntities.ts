import OpenAI from "openai";
import { z } from "zod";
import { getDataset } from "../config/manifest";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RdfTripleSchema = z.object({
  subject:        z.string().describe("Full IRI of the subject entity"),
  predicate:      z.string().describe("Full IRI of the predicate (from the ontology)"),
  object:         z.string().describe("Full IRI or literal value of the object"),
  objectIsLiteral:z.boolean().describe("True if object is a literal value, false if it is an IRI"),
  confidence:     z.number().min(0).max(1).describe("Extraction confidence [0-1]"),
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

interface OntologyBinding {
  class:   { value: string };
  label:   { value: string };
  comment?: { value: string };
}

/**
 * Activity: extract RDF triples from document text using GPT-4o.
 *
 * Ontology context is fetched live from the graph via POST /query/tbox.
 * The ontology class list is serialized to a compact text block and prepended
 * to the GPT-4o system prompt, coupling extraction quality to ontology maturity.
 *
 * If the ontology fetch fails (e.g. backend not yet ready), falls back to
 * dataset label as a minimal placeholder so the activity does not crash.
 *
 * Output is constrained by a Zod schema; if GPT-4o returns malformed JSON,
 * we retry once with the parse error injected into the follow-up prompt.
 */
export async function extractEntities(
  input: ExtractEntitiesInput
): Promise<ExtractEntitiesOutput> {
  const dataset = getDataset(input.datasetId);
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";

  const ontologyContext = await fetchOntologyContext(backendUrl, input.datasetId, dataset.label);

  const systemPrompt = `You are a knowledge graph extraction engine.
Extract RDF triples from the provided text using the ontology below.
Return ONLY triples that are explicitly supported by the text — do not infer.
Use full IRIs for subjects, predicates, and object IRIs.
For literals, use the raw value string.
For subject IRIs, use the pattern: ${backendUrl}/entity/{uuid-or-slug}

Ontology classes available:
${ontologyContext}

Respond with a JSON object: { "triples": [ { "subject", "predicate", "object", "objectIsLiteral", "confidence" } ] }`;

  const rawContent = await callGpt4o(systemPrompt, input.text);

  // First parse attempt
  const firstParse = ExtractionResultSchema.safeParse(JSON.parse(rawContent ?? "{}"));
  if (firstParse.success) {
    return firstParse.data;
  }

  // Retry: inject the parse error so GPT-4o can self-correct
  const retryContent = await callGpt4o(
    systemPrompt,
    `Your previous response failed schema validation:\n${firstParse.error.message}\n\nPlease re-extract from the original text:\n\n${input.text}`
  );

  const retryParse = ExtractionResultSchema.safeParse(JSON.parse(retryContent ?? "{}"));
  if (!retryParse.success) {
    throw new Error(`GPT-4o returned malformed extraction result after retry: ${retryParse.error.message}`);
  }

  return retryParse.data;
}

async function fetchOntologyContext(
  backendUrl: string,
  datasetId: string,
  datasetLabel: string
): Promise<string> {
  const sparql = `
    PREFIX owl:  <http://www.w3.org/2002/07/owl#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?class ?label ?comment WHERE {
      ?class a owl:Class ;
             rdfs:label ?label .
      OPTIONAL { ?class rdfs:comment ?comment }
    }
    ORDER BY ?label
  `;

  try {
    const res = await fetch(`${backendUrl}/query/tbox?dataset=${encodeURIComponent(datasetId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/sparql-query" },
      body: sparql,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as {
      results?: { bindings?: OntologyBinding[] };
    };

    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) {
      return `Dataset: ${datasetLabel} (no ontology classes found in graph)`;
    }

    return bindings
      .map((row) => {
        const comment = row.comment ? ` — ${row.comment.value}` : "";
        return `  ${row.label.value} (${row.class.value})${comment}`;
      })
      .join("\n");
  } catch (err) {
    // Non-fatal: fall back to a minimal placeholder so extraction can still proceed
    console.warn(
      `[extractEntities] Could not fetch ontology for dataset '${datasetId}': ${err}. Using placeholder.`
    );
    return `Dataset: ${datasetLabel} (ontology unavailable — using fallback context)`;
  }
}

async function callGpt4o(systemPrompt: string, userContent: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system",  content: systemPrompt },
      { role: "user",    content: `Extract RDF triples from the following text:\n\n${userContent}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  return response.choices[0].message.content ?? "{}";
}
