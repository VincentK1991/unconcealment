import type { RdfTriple } from "./extractEntities";
import { getDataset, namedGraphs, getBaseUri } from "../config/manifest";

export interface AssertToGraphInput {
  datasetId: string;
  documentIri: string;
  triples: RdfTriple[];
}

/**
 * Activity: assert extracted RDF triples into the knowledge graph with RDF-star provenance.
 * Routes through the Java backend's /query/raw endpoint (SPARQL UPDATE).
 *
 * Each triple is annotated with:
 *   - ex:sourceDocument  (documentIri)
 *   - ex:extractedAt     (current timestamp)
 *   - ex:confidence      (from extraction)
 *   - ex:extractionMethod "llm:gpt-4o"
 *   - ex:transactionTime (current timestamp)
 *
 * Targets the aboxAsserted named graph for the given datasetId (from manifest).
 * Nothing is hardcoded — dataset routing comes entirely from the manifest.
 *
 * TODO (Phase 1): implement SPARQL UPDATE with RDF-star syntax via HTTP to backend.
 */
export async function assertToGraph(
  input: AssertToGraphInput
): Promise<void> {
  const dataset = getDataset(input.datasetId);
  const graphs = namedGraphs(input.datasetId);
  const namedGraph = graphs.aboxAsserted;
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";

  for (const triple of input.triples) {
    const now = new Date().toISOString();

    // Build RDF-star SPARQL UPDATE
    // << subject predicate object >> provenance-predicate provenance-object
    const objectTerm = triple.objectIsLiteral
      ? `"${triple.object.replace(/"/g, '\\"')}"`
      : `<${triple.object}>`;

    const sparql = `
      PREFIX ex: <https://kg.unconcealment.io/ontology/>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

      INSERT DATA {
        GRAPH <${namedGraph}> {
          << <${triple.subject}> <${triple.predicate}> ${objectTerm} >>
            ex:sourceDocument  <${input.documentIri}> ;
            ex:extractedAt     "${now}"^^xsd:dateTime ;
            ex:confidence      ${triple.confidence} ;
            ex:extractionMethod "llm:gpt-4o" ;
            ex:transactionTime "${now}"^^xsd:dateTime .

          <${triple.subject}> <${triple.predicate}> ${objectTerm} .
        }
      }
    `;

    // TODO (Phase 1): POST to ${backendUrl}/query/raw?dataset=${input.datasetId}
    // For now, log the generated SPARQL
    console.log(
      `[assertToGraph] Dataset=${input.datasetId} Graph=${namedGraph}\n${sparql}`
    );
  }
}
