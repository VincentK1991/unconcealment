---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 9: Recap and Future Direction
---

<br>

# What I actually built

Looking back at this series, I want to take stock of what the proof of concept actually is, separate from the aspirational vision I described in the intro.

The working system is a metadata-driven knowledge graph with the following components:

A **Java backend** running Apache Jena Fuseki as the triplestore, with a Spring Boot service sitting in front of it. The backend handles SPARQL query routing (reasoned vs. raw vs. text search), loads OWL/RDFS ontologies and Jena rule language rules from the TBox named graphs, and manages IRI minting for extracted entities. The reasoning engine is Jena's GenericRuleReasoner in hybrid mode — forward chaining for stable rules materialized at load time, backward chaining for domain-specific rules evaluated at query time.

A **TypeScript indexing pipeline** built on Temporal for workflow orchestration. It takes PDF and plain-text documents, OCRs them with liteparse, chunks and embeds them with OpenAI's text-embedding-3-small, extracts entities and relationships from each chunk with GPT-4o using ontology-guided structured output, asserts the results to the graph via the Java backend, runs two-tier entity normalization (Jaro-Winkler rule-based + GPT-4o LLM-as-judge), and handles rollback via Temporal's saga pattern if anything fails.

An **Astro + React web frontend** providing Wikipedia-style entity pages, a force-directed entity graph visualization, a normalization explorer, a SPARQL query explorer, a BigQuery SQL explorer, and a reasoning playground for testing inference rules.

Two domain **ontologies** with forward and backward chaining rules: economic census (covering census counties, statistical observations, surveys, geographic hierarchies) and public health (covering health outcomes, interventions, populations). Both have BigQuery semantic binding layers describing tables from ACS, Opportunity Atlas, and BLS QCEW.

A separate **insurance benchmark dataset** using Ontop for SPARQL-to-SQL query rewriting — this was a side exploration into virtual knowledge graphs that ended up as a benchmark rather than a production feature.

# What worked

The **Temporal workflow orchestration** worked extremely well. I was initially skeptical about the overhead of a full workflow engine for what is essentially an ETL pipeline, but the retry-with-backoff handling, heartbeating for long activities, and compensation logic for rollback saved me enormous debugging time. Several times I had a failure late in a pipeline run (a bad assertion payload, a Fuseki connection issue) and the rollback cleanly unwound what was written. Without Temporal I'd have needed to clean up manually or write my own saga logic.

**Ontology-guided extraction** was surprisingly effective. Fetching the current ontology from the graph and appending it to the LLM prompt meant the extraction quality tracked the ontology quality. As I refined the ontology classes and properties over several iterations, the extractions improved without any code changes to the pipeline. The feedback loop between "what entities am I getting?" and "what ontology terms do I need to define?" was fast.

The **two-tier normalization** hit a good cost-quality tradeoff. Most obvious duplicates were handled cheaply by Jaro-Winkler. The LLM step was rarely invoked — only for the genuinely ambiguous cases — and when it was, it usually got them right. The owl:sameAs non-destructive approach meant I never had a hard-to-undo merge decision.

The **named graph architecture** — keeping asserted, inferred, normalization, provenance, and TBox data in separate named graphs — made a huge difference for operations like rolling back a specific indexing run or re-materializing the inferred graph after a rule change. Everything is scoped and segmented.

# What didn't work as well

The **web frontend** is functional but not polished. The force-directed graph visualization is visually impressive but not that useful for actual knowledge navigation — it's more of a toy for exploring connectivity than a practical tool. A better approach would probably be a table-based property view with inline expansion, more like a classic database browser, rather than a physics simulation.

The **per-chunk entity extraction** has obvious limitations. The LLM only sees one chunk at a time, which means relationships that span chunks (an entity mentioned in chunk 2 related to something only described in chunk 5) will be missed. A smarter approach would be to do a document-level first pass for context before chunk-level extraction. But that adds cost and latency.

**IRI minting** at the Java backend was a pragmatic decision but it created some awkward coupling. The TypeScript pipeline sends entity labels and ontology local names, and the Java backend mints IRIs and resolves them to full ontology URIs. This is the right separation but it means the TypeScript pipeline can't easily inspect the full IRI until after the assertion. A cleaner design might mint IRIs in the TypeScript pipeline before sending to the backend.

The **BigQuery integration** is half-implemented. The binding layer is fully built and the context builder generates good prompts. But the end-to-end flow where an MCP tool receives an entity, enriches it with BigQuery data, and returns a unified answer to the LLM — that's more of a sketch than a working feature. Building that out properly would be the next milestone.

# Design decisions I'd make the same way again

**RDF over labeled property graph.** The ontology-as-business-logic principle, owl:sameAs for non-destructive normalization, and named graph segmentation are all things that work much better in RDF than in a typical LPG. Yes, RDF requires more upfront investment in ontology design, and yes, it's more verbose. But the payoffs in reasoning, normalization, and schema evolution are real.

**Two languages, one runtime per language.** Java for the backend (stable, Jena support is Java-only, well-understood), TypeScript for the indexing pipeline and web frontend. Maintaining exactly two languages is a meaningful operational simplification. I didn't have to deal with Python, Go, or anything else sneaking into the stack.

**Metadata-driven over code-driven.** The manifest.yaml drives which datasets exist and which features they have. Adding a new dataset means adding a YAML block and an ontology folder. No code changes. This was validated when I added the public health dataset — the pipeline picked it up automatically.

**Continuous graph lifecycle.** Never nuke and rebuild. The inferred graph is the only ephemeral part. Everything else — assertions, normalization decisions, provenance, system health events — accumulates and is managed, not periodically wiped. This is the right model for any system that needs auditability.

# Future directions

If I were to continue this as more than a proof of concept, the things I'd prioritize are:

**Full MCP integration.** The semantic layer is built. The missing piece is wiring it to Claude (or another LLM) via MCP tools so you can ask natural language questions and get grounded, source-cited answers. This is the headline feature and the thing that makes everything else worth having.

**SHACL validation at ingestion.** Right now the system operates under open world assumption — anything that gets past the Zod schema validation in the TypeScript pipeline can go into the graph. Adding SHACL validation gates at the Java ingest endpoint would catch structural inconsistencies before they propagate.

**Global deduplication sweep.** The per-document normalization step handles new entities well, but it doesn't catch duplicates that appeared in different documents at different times without overlapping indexing runs. A periodic batch job that runs full pairwise dedup over all entities would clean these up.

**Ontology alignment with external vocabularies.** The current ontologies are bespoke. Aligning them with Schema.org, DBpedia, or FHIR (for health) would enable federation — being able to run SPARQL SERVICE queries against external SPARQL endpoints using shared ontology terms. This is where the RDF vision of "web of data" actually comes true.

**Production hardening.** Prometheus + Grafana for observability, Kubernetes for container orchestration, proper authentication on the SPARQL endpoint, rate limiting on the MCP tools. None of this was in scope for a proof of concept.

# Final thoughts

I started this series motivated by the question of whether the old pre-LLM technology stack — knowledge graphs, formal ontologies, semantic web standards — has a role to play in the era of LLMs. My conclusion after building this proof of concept is: yes, but not in the way people usually describe it.

The usual framing is knowledge graphs as alternatives to LLMs for structured reasoning. I think that framing is mostly wrong. LLMs are much better than knowledge graphs at understanding natural language, generating text, and reasoning over fuzzy context. Knowledge graphs are much better than LLMs at provenance, precise entity identity, schema enforcement, and long-term fact accumulation.

The more interesting question is how they work together. The knowledge graph is the grounding mechanism — it's where you store things that need to be remembered precisely, sourced, and auditable. The LLM is the interface — it understands what you're asking, figures out how to query the graph, synthesizes results into natural language, and decides when to trust the graph and when to be uncertain.

In the agentic era, the knowledge graph is essentially a long-term, structured external memory that the AI can query with precision. The AI doesn't need to know RDF. It doesn't need to write SPARQL. It just needs a set of tools that abstract over the graph in a way that's semantically rich and trustworthy. That's what this system is trying to be.

Whether any of this matters in practice depends entirely on whether you're building for a use case where provenance, auditability, and precise entity identity matter. For a personal wiki, probably not — a markdown folder plus a vector search is enough. For an enterprise system dealing with regulatory compliance, multi-source data integration, or any domain where "where did this fact come from" is a real question — I think it matters a lot.

That's the argument this blog series has been trying to make. I hope it was useful.
