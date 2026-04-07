export interface SparqlTermSnapshot {
  termType: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  language?: string;
}

export interface GraphAnnotationSnapshot {
  predicate: SparqlTermSnapshot;
  object: SparqlTermSnapshot;
}

export interface GraphTripleSnapshot {
  subject: SparqlTermSnapshot;
  predicate: SparqlTermSnapshot;
  object: SparqlTermSnapshot;
  annotations: GraphAnnotationSnapshot[];
}

export interface GraphSnapshot {
  datasetId: string;
  documentIri: string;
  triples: GraphTripleSnapshot[];
}
