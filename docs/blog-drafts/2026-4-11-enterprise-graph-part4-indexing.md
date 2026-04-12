---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 4: Data Indexing Pipeline
---

<br>

# The indexing pipeline

So far I've talked about why knowledge graphs, why RDF, and what the design looks like at a conceptual level. Now let's get into actually getting data into the thing. This is the indexing pipeline — the part that takes a raw document and turns it into triples living in the graph.

The short version of the pipeline is: you give it a document (a PDF, or a plain text file), and it comes out the other end as a set of entities and relationships asserted into the RDF store, with full provenance attached. The long version involves a few interesting design decisions that I want to walk through.

# Why Temporal

The first thing I want to explain is why I'm using Temporal as the workflow orchestration layer. Temporal is a workflow orchestration system that lets you write long-running, reliable workflows in code. The key property it gives you is durability — if a step fails halfway, the workflow can resume from where it left off rather than starting from scratch. This is important for an indexing pipeline because individual steps can be slow and expensive (OCR on a PDF, LLM extraction across 20 chunks), and you don't want to redo them if one step downstream fails.

The other thing Temporal gives you is compensation / rollback. If the pipeline fails after inserting data into the graph but before finishing normalization, you want to be able to clean up the partial state rather than leaving orphaned data behind. This is what saga pattern is about. I implemented a basic rollback — if something throws late in the pipeline, the workflow deletes what it wrote to the graph, restores the previous document embeddings from a snapshot, and removes the raw file from storage if it was newly created.

# Steps of the pipeline

The pipeline is a sequence of activities:

**1. Upload source document**

The first thing the pipeline does is upload the raw document to MinIO (an S3-compatible object store). This is the permanent store of the original raw files. The document gets a deterministic key based on the dataset and document identifier.

**2. Resolve content**

Once the raw file is in storage, the next step is to get text out of it. For plain text files, this is trivial — just read the content. For PDFs, I use liteparse for OCR text extraction. The resolved text is stored back in MinIO as a separate text object. This separation is useful because the rest of the pipeline works only with text, and you don't want to re-OCR the PDF on every retry.

Liteparse is a local OCR tool that I wired up as a command-line process. It's not perfect. For some PDFs with complex layouts or tables it struggles. But for the kinds of reports and articles I was indexing (census reports, public health documents), it worked well enough.

**3. Chunk and embed**

The text gets chunked into overlapping windows (16k characters per chunk, 100-character overlap). Each chunk is then sent to OpenAI's text-embedding-3-small to get a vector embedding. The embeddings are stored in Postgres alongside the raw chunk text using the pgvector extension. This is the part of the system that enables semantic (vector) search later — you can find relevant chunks by embedding a query and searching for nearby vectors.

The Postgres side stores both the raw text and the embedding for each chunk, associated with the document IRI. This is how the system can later retrieve the source text when you ask "show me the original passage this fact came from".

One implementation detail worth mentioning: I batch the embedding calls (100 chunks per API call, 3 concurrent batches) with exponential backoff on rate limit errors. For large documents this step can take a few minutes, so I also send heartbeats to Temporal so the orchestrator knows the activity is still running.

**4. Extract entities and relationships**

This is the most interesting step. For each chunk, the pipeline sends a structured extraction request to GPT-4o. The LLM is given the chunk text and asked to extract entities and relationships according to the ontology.

The key design decision here is that the LLM doesn't know anything about the graph or the existing entities — it only sees the chunk text and the ontology. It outputs JSON with two arrays: entities (with label, type, description, and attributes) and relationships (encoded as indices into the entities array).

The ontology is fetched live from the graph at extraction time. I built a SPARQL query that pulls all classes and properties from the ontology TBox named graph and formats them into a readable list appended to the system prompt. This means if the ontology evolves — you add a new class or property — the extraction pipeline automatically picks it up without any code changes.

The structured output uses OpenAI's structured output mode with Zod schemas. The schema validates that entity indices are in range, that objectId and objectIsLiteral are consistent, and other basic correctness properties. If the model returns invalid output, the pipeline does one retry with the error message appended to the prompt ("the previous extraction returned invalid output: ...").

All chunks are fanned out in parallel — each chunk is a separate activity. Then the results are merged: entities are flattened into a single array and relationship indices are re-offset to point into the combined array.

**5. Assert to graph**

The merged extraction result gets posted to the Java backend's `/ingest/assertions` endpoint. The Java backend is responsible for everything that requires understanding RDF: minting entity IRIs (deterministic UUID-based), resolving ontology local names to full IRIs, building the RDF-star SPARQL INSERT DATA statements with provenance annotations, and writing to the dataset's asserted named graph.

The provenance attached to each triple includes: which document it came from, when it was extracted, which extraction method (the model name), and the indexing run ID. The indexing run ID is key — it lets the normalization step later find "which entities were asserted in this specific run" without scanning the entire graph.

**6. Normalize**

After assertions are written, the pipeline kicks off normalization. I'll describe this in the next post since it has enough interesting stuff to deserve its own section. But the short version is: it tries to deduplicate entities against what's already in the graph, writing owl:sameAs links when it finds matches.

# The rollback story

One thing I'm fairly happy with in this implementation is the rollback. If anything fails in the pipeline, the compensation logic unwinds what was written, in reverse order. Normalization gets deleted (by indexing run ID from the RDF-star annotation). Graph assertions get deleted. Postgres embeddings get restored from the snapshot that was captured before the upsert (if it's a re-indexing of an existing document). The raw file in MinIO gets deleted if it was newly created.

This matters for the continuous graph lifecycle principle — I don't want partial indexing runs to leave garbage in the graph. The rollback tries to be a clean undo of what was done.

The snapshot approach for document restoration is worth explaining. When a document is re-indexed (e.g., the document was updated or re-ingested), the pipeline loads the previous state of the document and its chunks from Postgres and saves that snapshot to MinIO before doing the upsert. If the pipeline fails later, the restore activity writes the snapshot back to Postgres. This way re-indexing is idempotent and recoverable.

# What I think about this

Looking at this pipeline, I think the most important design decision was using Temporal. Without durable workflow orchestration, you'd have to implement all of the retry logic, partial failure handling, and compensation yourself in application code, and it would be a mess. Temporal handles all of that and lets me write the pipeline as if it were a simple sequential function.

The LLM extraction step is the one I'm most uncertain about. The quality of extraction depends heavily on the quality of the ontology and the prompt. For the domains I tested (economic census, public health), it worked reasonably well for obvious entities and relationships. But for subtle or cross-sentence relationships, or entities that require broader context, the per-chunk extraction misses things. A more sophisticated approach would be to do a first-pass reading of the whole document before extraction, but that gets expensive quickly.

The chunking strategy (16k characters) is also something I'd revisit. Large chunks give the LLM more context for extraction but increase token cost and can confuse the model about what to extract. Smaller chunks are cheaper but lose cross-sentence context. I picked 16k because it fits cleanly within GPT-4o's context window and covers most paragraphs with room to spare, but it's not a principled choice.
