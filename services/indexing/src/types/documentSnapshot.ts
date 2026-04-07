export interface DocumentChunkSnapshot {
  id: string;
  documentId: string;
  documentIri: string;
  datasetId: string;
  chunkText: string;
  chunkIndex: number;
  embedding: string | null;
  sourceUrl: string;
  createdAt: string;
}

export interface DocumentRecordSnapshot {
  id: string;
  documentIri: string;
  datasetId: string;
  sourceUrl: string;
  content: string;
  contentHash: string;
  mimeType: string | null;
  ocrEngine: string | null;
  storageBucket: string | null;
  storageObjectKey: string | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSnapshot {
  document: DocumentRecordSnapshot;
  chunks: DocumentChunkSnapshot[];
}
