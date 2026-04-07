export const PIPELINE_CONSTANTS = {
  chunk: {
    size: 16000,
    overlap: 100,
  },
  models: {
    embedding:   "text-embedding-3-small",
    extraction:  "gpt-4o-2024-08-06",
    normalization: "gpt-4o-2024-08-06",
  },
  extraction: {
    method: "llm:gpt-4o+liteparse",
  },
  normalization: {
    // Jena-text top-K candidates fetched per new entity
    candidateLimit: 100,
    // Jaro-Winkler: at or above this → assert sameAs without LLM
    highConfidenceThreshold: 0.92,
    // Jaro-Winkler: at or above this but below high → send to LLM
    lowConfidenceThreshold: 0.75,
    // LLM judgements at or above this confidence are accepted
    llmAcceptThreshold: 0.80,
  },
  retry: {
    initialIntervalMs: 1000,
    backoffCoefficient: 2,
    maximumIntervalMs: 30000,
    maximumAttempts: 5,
  },
} as const;

export const SPARQL_ONTOLOGY_CONTEXT_QUERY = `
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?term ?termType ?label ?comment WHERE {
  {
    ?term a owl:Class ; rdfs:label ?label .
    BIND("class" AS ?termType)
  } UNION {
    ?term a ?propType ; rdfs:label ?label .
    FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
    BIND("property" AS ?termType)
  }
  OPTIONAL { ?term rdfs:comment ?comment }
}
ORDER BY ?termType ?label
`;

export const EXTRACTION_RESPONSE_FORMAT_DESCRIPTION =
  '{ "entities": [ { "label", "type" } ], "relationships": [ { "subjectId", "predicate", "objectId", "objectLiteral", "objectIsLiteral", "confidence" } ] }';

export const DEFAULT_TRIGGER_DOCUMENT_TEXT = `
King County, Washington is the most populous county in Washington State and the 13th-most
populous county in the United States. As of the 2020 Census, the population was 2,269,675.
The county seat is Seattle. King County had a median household income of approximately
$93,000 in 2021 according to the American Community Survey. The unemployment rate was
3.2% in the same period. The county includes parts of the Seattle metropolitan area,
encompassing cities such as Bellevue, Redmond, and Kirkland.
The FIPS code for King County is 53033.
`.trim();

export function buildExtractionSystemPrompt(
  ontologyClasses: string,
  ontologyProperties: string,
): string {
  return `You are a knowledge graph extraction engine.
Extract entities and relationships from the provided text using the ontology below.

OUTPUT FORMAT:
{
  "entities": [
    {
      "label": "<human-readable entity name>",
      "type": "<ontology class local name>",
      "description": "<1-3 sentence factual summary of this entity drawn directly from the text>",
      "attributes": [
        { "predicate": "<ontology property local name>", "value": "<scalar literal>" },
        ...
      ]
    },
    ...
  ],
  "relationships": [
    {
      "subjectId": <int>,
      "predicate": "<ontology property local name>",
      "objectId": <int or null>,
      "objectLiteral": "<string or null>",
      "objectIsLiteral": <true|false>,
      "confidence": <0.0-1.0>
    },
    ...
  ]
}

RULES:
- Each entity appears exactly once in the entities array. Its 0-based position in the array is its id.
- Use the 0-based array index (not the label) in subjectId and objectId.
- If objectIsLiteral is false: set objectId to the entity's index, set objectLiteral to null.
- If objectIsLiteral is true: set objectLiteral to the literal value (date, number, text), set objectId to null.
- Only extract relationships explicitly supported by the text — do not infer.
- description: write 1-3 sentences summarising what this entity is, based solely on the text. Use an empty string if the text provides no meaningful context.
- attributes: capture scalar facts that are INTRINSIC to the entity itself (e.g. founding year, publication date, identifier codes, geographic location). Do NOT repeat here facts that are already expressed as an inter-entity relationship in the relationships array.

EXAMPLE:
Text: "Apple Inc. was founded in 1976 in Cupertino, CA. Tim Cook is the CEO of Apple Inc."

{
  "entities": [
    {
      "label": "Apple Inc.",
      "type": "Organization",
      "description": "Apple Inc. is a technology company founded in 1976 and headquartered in Cupertino, CA.",
      "attributes": [
        { "predicate": "foundingYear", "value": "1976" },
        { "predicate": "headquarteredIn", "value": "Cupertino, CA" }
      ]
    },
    {
      "label": "Tim Cook",
      "type": "Person",
      "description": "Tim Cook is the CEO of Apple Inc.",
      "attributes": []
    }
  ],
  "relationships": [
    { "subjectId": 1, "predicate": "isLeaderOf", "objectId": 0, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.92 }
  ]
}
(entities[0] = "Apple Inc.", entities[1] = "Tim Cook" — subjectId/objectId reference those positions)

Ontology classes (use the local name as the entity "type"):
${ontologyClasses}

Ontology properties (use the local name as the relationship "predicate" or attribute "predicate"):
${ontologyProperties}`;
}
