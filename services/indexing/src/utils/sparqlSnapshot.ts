import type {
  GraphAnnotationSnapshot,
  GraphSnapshot,
  GraphTripleSnapshot,
  SparqlTermSnapshot,
} from "../types/graphSnapshot";

export interface SparqlJsonBinding {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  [key: string]: string | undefined;
}

export interface SparqlJsonRow {
  s: SparqlJsonBinding;
  p: SparqlJsonBinding;
  o: SparqlJsonBinding;
  annP?: SparqlJsonBinding;
  annO?: SparqlJsonBinding;
}

function escapeSparqlLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function serializeSparqlTerm(term: SparqlTermSnapshot): string {
  if (term.termType === "uri") {
    return `<${term.value}>`;
  }

  if (term.termType === "bnode") {
    return `_:${term.value}`;
  }

  const escaped = escapeSparqlLiteral(term.value);
  if (term.language) {
    return `"${escaped}"@${term.language}`;
  }
  if (term.datatype) {
    return `"${escaped}"^^<${term.datatype}>`;
  }
  return `"${escaped}"`;
}

export function termFromBinding(binding: SparqlJsonBinding): SparqlTermSnapshot {
  return {
    termType: binding.type,
    value: binding.value,
    datatype: binding.datatype,
    language: binding["xml:lang"],
  };
}

function tripleKey(triple: GraphTripleSnapshot): string {
  return JSON.stringify({
    s: triple.subject,
    p: triple.predicate,
    o: triple.object,
  });
}

function annotationKey(annotation: GraphAnnotationSnapshot): string {
  return JSON.stringify(annotation);
}

export function buildGraphSnapshot(
  datasetId: string,
  documentIri: string,
  rows: SparqlJsonRow[]
): GraphSnapshot {
  const triples = new Map<string, GraphTripleSnapshot>();

  for (const row of rows) {
    const triple: GraphTripleSnapshot = {
      subject: termFromBinding(row.s),
      predicate: termFromBinding(row.p),
      object: termFromBinding(row.o),
      annotations: [],
    };

    const key = tripleKey(triple);
    const existing = triples.get(key) ?? triple;

    if (row.annP && row.annO) {
      const annotation: GraphAnnotationSnapshot = {
        predicate: termFromBinding(row.annP),
        object: termFromBinding(row.annO),
      };
      const seen = new Set(existing.annotations.map(annotationKey));
      if (!seen.has(annotationKey(annotation))) {
        existing.annotations.push(annotation);
      }
    }

    triples.set(key, existing);
  }

  return {
    datasetId,
    documentIri,
    triples: Array.from(triples.values()),
  };
}

export function buildInsertDataForGraphSnapshot(snapshot: GraphSnapshot, graphIri: string): string {
  if (snapshot.triples.length === 0) {
    return "";
  }

  const blocks = snapshot.triples.map((triple) => {
    const subject = serializeSparqlTerm(triple.subject);
    const predicate = serializeSparqlTerm(triple.predicate);
    const object = serializeSparqlTerm(triple.object);
    const baseTriple = `${subject} ${predicate} ${object} .`;
    const annotations = triple.annotations
      .map((annotation) => {
        return `    << ${subject} ${predicate} ${object} >> ${serializeSparqlTerm(annotation.predicate)} ${serializeSparqlTerm(annotation.object)} .`;
      })
      .join("\n");

    return annotations ? `${baseTriple}\n${annotations}` : baseTriple;
  });

  return `INSERT DATA {\n  GRAPH <${graphIri}> {\n    ${blocks.join("\n\n    ")}\n  }\n}`;
}
