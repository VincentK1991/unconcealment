import { PrismaClient } from "@prisma/client";
import { namedGraphs } from "../config/manifest";

const prisma = new PrismaClient();

export interface RollbackIndexingInput {
  datasetId: string;
  documentIri: string;
  indexingRunId: string;
  chunkIds: string[];
  documentId?: string;
}

function escapeSparqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function rollbackIndexing(input: RollbackIndexingInput): Promise<void> {
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphs = namedGraphs(input.datasetId);

  const rollbackSparql = `
PREFIX ex: <http://localhost:4321/ontology/>
DELETE {
  GRAPH <${graphs.aboxAsserted}> {
    ?s ?p ?o .
    << ?s ?p ?o >> ?annP ?annO .
  }
}
WHERE {
  GRAPH <${graphs.aboxAsserted}> {
    << ?s ?p ?o >> ex:indexingRun "${escapeSparqlLiteral(input.indexingRunId)}" ;
                  ex:sourceDocument <${input.documentIri}> .
    OPTIONAL { << ?s ?p ?o >> ?annP ?annO . }
    FILTER NOT EXISTS {
      << ?s ?p ?o >> ex:indexingRun ?otherRun .
      FILTER(?otherRun != "${escapeSparqlLiteral(input.indexingRunId)}")
    }
  }
}
`;

  const graphRes = await fetch(`${backendUrl}/query/update?dataset=${encodeURIComponent(input.datasetId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-update" },
    body: rollbackSparql,
  });

  if (!graphRes.ok) {
    const body = await graphRes.text();
    throw new Error(`Rollback graph cleanup failed: HTTP ${graphRes.status} — ${body}`);
  }

  if (input.chunkIds.length > 0) {
    await prisma.documentChunk.deleteMany({
      where: { id: { in: input.chunkIds } },
    });
  }

  if (input.documentId) {
    await prisma.document.delete({
      where: { id: input.documentId },
    }).catch(async () => {
      await prisma.document.deleteMany({
        where: { documentIri: input.documentIri, datasetId: input.datasetId },
      });
    });
  }
}
