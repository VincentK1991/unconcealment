import type { RdfTriple } from "./extractEntities";
import { namedGraphs } from "../config/manifest";

export interface AssertToGraphInput {
  datasetId: string;
  documentIri: string;
  triples: RdfTriple[];
}

/**
 * Activity: assert extracted RDF triples into the knowledge graph with RDF-star provenance.
 * Posts SPARQL UPDATE to POST /query/update?dataset={datasetId} on the Java backend.
 *
 * Each triple is annotated via RDF-star with:
 *   ex:sourceDocument   — the document IRI this triple was extracted from
 *   ex:extractedAt      — ISO timestamp of extraction
 *   ex:confidence       — GPT-4o extraction confidence [0-1]
 *   ex:extractionMethod — "llm:gpt-4o"
 *   ex:transactionTime  — when this triple was recorded in the graph
 *
 * Triples are written to the dataset's abox:asserted named graph.
 * Both the base triple and its RDF-star annotation are inserted in a single UPDATE.
 *
 * Jena 5.x + Fuseki 5.5.0 support RDF-star natively:
 *   << subject predicate object >> annotation-predicate annotation-object
 */
export async function assertToGraph(input: AssertToGraphInput): Promise<void> {
  const graphs = namedGraphs(input.datasetId);
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const endpoint = `${backendUrl}/query/update?dataset=${encodeURIComponent(input.datasetId)}`;

  for (const triple of input.triples) {
    const now = new Date().toISOString();
    const objectTerm = triple.objectIsLiteral
      ? `"${triple.object.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : `<${triple.object}>`;

    const sparql = `
PREFIX ex:  <https://kg.unconcealment.io/ontology/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

INSERT DATA {
  GRAPH <${graphs.aboxAsserted}> {
    <${triple.subject}> <${triple.predicate}> ${objectTerm} .

    << <${triple.subject}> <${triple.predicate}> ${objectTerm} >>
      ex:sourceDocument   <${input.documentIri}> ;
      ex:extractedAt      "${now}"^^xsd:dateTime ;
      ex:confidence       ${triple.confidence} ;
      ex:extractionMethod "llm:gpt-4o" ;
      ex:transactionTime  "${now}"^^xsd:dateTime .
  }
}
`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/sparql-update" },
      body: sparql,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `assertToGraph failed for dataset=${input.datasetId}: HTTP ${res.status} — ${body}`
      );
    }
  }
}
