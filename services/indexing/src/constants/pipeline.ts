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
SELECT
  ?term
  ?termType
  (SAMPLE(?label0) AS ?label)
  (SAMPLE(?comment0) AS ?comment)
  (SAMPLE(?propertyKind0) AS ?propertyKind)
  (GROUP_CONCAT(DISTINCT STR(?domain0); separator=" | ") AS ?domains)
  (GROUP_CONCAT(DISTINCT STR(?range0); separator=" | ") AS ?ranges)
WHERE {
  {
    ?term a owl:Class .
    BIND("class" AS ?termType)
  } UNION {
    ?term a ?propType .
    FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
    BIND("property" AS ?termType)
    BIND(IF(?propType = owl:ObjectProperty, "object", "datatype") AS ?propertyKind0)
    OPTIONAL { ?term rdfs:domain ?domain0 }
    OPTIONAL { ?term rdfs:range ?range0 }
  }
  OPTIONAL { ?term rdfs:label ?label0 }
  OPTIONAL { ?term rdfs:comment ?comment0 }
}
GROUP BY ?term ?termType
ORDER BY ?termType ?label ?term
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
Treat the ontology as strong guidance, not as a hard restriction.

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
- Prefer curated ontology terms from the context below when they fit the text.
- If no curated ontology term fits, emit a short novel local name rather than forcing a semantically wrong curated term.
- Object properties connect one extracted entity to another extracted entity.
- Datatype properties represent scalar values such as numbers, dates, identifiers, codes, and short text values.
- Prefer intrinsic scalar facts in attributes.
- Prefer compositional modeling over bespoke predicates. When the ontology offers an observation/measure/geography-style pattern, model the numeric claim as an observation entity linked to a measure and geography rather than inventing a one-off predicate for the metric.
- Do not create entities for every noun phrase. Create entities only when they carry stable semantic identity in the text.

ILLUSTRATIVE EXAMPLE:
This example shows preferred structure only. The exact types and predicates you emit must come from the ontology context for this dataset when available.

Text: "In 2023, California's poverty rate was 12.5 percent according to the American Community Survey."

{
  "entities": [
    {
      "label": "2023 California poverty rate",
      "type": "StatisticalObservation",
      "description": "A statistical observation reporting California's poverty rate in 2023.",
      "attributes": [
        { "predicate": "observationValue", "value": "12.5" },
        { "predicate": "referenceYear", "value": "2023" }
      ]
    },
    {
      "label": "California",
      "type": "State",
      "description": "A U.S. state.",
      "attributes": [
        { "predicate": "fipsCode", "value": "06" }
      ]
    },
    {
      "label": "povertyRate",
      "type": "StatisticalMeasure",
      "description": "A named statistical measure representing the poverty rate.",
      "attributes": [
        { "predicate": "measureName", "value": "povertyRate" },
        { "predicate": "measureUnit", "value": "percent" },
        { "predicate": "measureType", "value": "rate" }
      ]
    },
    {
      "label": "American Community Survey",
      "type": "CensusSurvey",
      "description": "A Census Bureau survey program.",
      "attributes": [
        { "predicate": "surveyName", "value": "American Community Survey" },
        { "predicate": "surveyVintage", "value": "2023" }
      ]
    }
  ],
  "relationships": [
    { "subjectId": 0, "predicate": "refersToGeography", "objectId": 1, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.95 },
    { "subjectId": 0, "predicate": "measures", "objectId": 2, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.95 },
    { "subjectId": 0, "predicate": "derivedFrom", "objectId": 3, "objectLiteral": null, "objectIsLiteral": false, "confidence": 0.90 }
  ]
}

(entities[0] = observation, entities[1] = geography, entities[2] = measure, entities[3] = survey — subjectId/objectId reference those positions)

Curated ontology classes (use the local name as the entity "type"):
${ontologyClasses}

Curated ontology properties (use the local name as the relationship "predicate" or attribute "predicate"):
${ontologyProperties}`;
}
