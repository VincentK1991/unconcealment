---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 8: Knowledge Unification with AI
---

<br>

# How AI actually uses a knowledge graph

I've been talking a lot about building the graph — indexing documents, normalizing entities, building the ontology. But the whole point of building this thing is so that AI can use it. How does that actually work?

The primary interface for AI consumption is MCP — the Model Context Protocol, which is Anthropic's standard for giving LLMs access to tools. In this architecture, the MCP tools are thin wrappers around the Java backend's query endpoints. The LLM calls the tool, the tool hits the backend, the backend runs the query (with or without inference, depending on what's needed), and the results come back to the LLM as structured data.

The key design principle is that the LLM should never need to understand RDF or SPARQL directly. The MCP tools abstract over that. The LLM asks for an entity by name, gets back a structured description of that entity with all its properties and relationships. It asks for documents related to a topic, gets back a ranked list with excerpts. It doesn't know whether the results come from a triplestore or a SQL database — and it doesn't need to.

# The query routing architecture

The Java backend exposes several query endpoints with different reasoning characteristics:

`/query/reasoned` — runs the query through the InfModel, which applies both forward-chained rules (already materialized) and backward-chained rules (evaluated at query time). This is the main endpoint for entity lookups — when you ask about an entity, you get its own properties plus everything that the inference rules can derive: properties from sameAs-equivalent entities, derived classifications, rule-derived relationships.

`/query/raw` — bypasses the reasoner entirely and queries the raw TDB2 store. Used for provenance lookups and health queries where you want to see exactly what's in the graph without inference adding anything.

`/query/text` — full text search via the Jena-text (Apache Lucene) index. Returns entities whose rdfs:label matches the search term. This runs against the raw index, not the InfModel, so results then need a second hop through the InfModel to resolve canonical entity identity.

`/query/tbox` — queries the TBox named graphs (ontology, rules). Used by the indexing pipeline to fetch the current ontology for LLM guidance, and by UI components that need to browse the schema.

# The two-hop full text search

The full text search flow is worth explaining in detail because it's a good example of how the pieces fit together. When the LLM asks for entities matching a text query, the flow is:

1. The query hits the Jena-text Lucene index. This index is built over rdfs:label literals. It returns matching entity IRIs along with relevance scores.

2. The returned IRIs might be variant (non-canonical) entities — entities that got normalized via owl:sameAs. So those IRIs get handed to the InfModel for canonical resolution. The owl:sameAs closure is applied, and the canonical entity IRI is returned.

3. The canonical entity IRI is then used for everything else — fetching properties, relationships, provenance.

This two-hop pattern exists because the Jena-text index operates directly on the raw TDB2 store and doesn't participate in inference. An entity labeled "King County, WA" might be in the text index but might be marked as a sameAs variant of the canonical "King County, Washington" entity. If you only returned the text match, you'd get the variant with an incomplete set of properties. The second hop through the reasoner collapses the sameAs cluster and gives you the full canonical view.

# owl:sameAs transparency

One of the nicest properties of this architecture is that owl:sameAs normalization is invisible to MCP tool consumers. The tool asks for an entity, and the reasoner automatically includes all properties from all co-referent variants. You don't have to know that the data was extracted across three different documents with three slightly different labels. From the tool's perspective, there's just one entity with a complete set of properties.

This is the payoff for all of the normalization work in part 5. Without it, the LLM would have to manually figure out that "King County, WA", "King County, Washington", and "King County (WA)" are the same thing, and manually aggregate their properties. With it, that's the reasoner's job.

# Reasoning as a query-time enrichment

Backward chaining rules make the knowledge graph more powerful than just a lookup table. A backward rule is essentially a derived predicate — a fact that can be derived from other facts at query time.

For example, in this system I have rules for entity classification based on properties. An entity with a fipsCode property and certain other features can be classified as a County even if it wasn't explicitly typed as County in the extraction. The backward rule fires when the reasoner tries to evaluate `?entity a County` — it checks whether the evidence pattern matches, and if so returns true.

This means the graph doesn't need to explicitly store every derivable fact. The rules encode the domain logic. Adding a new rule changes what can be inferred without touching the stored data. This is the "ontology as business logic" principle from the design posts.

The reasoning playground I described in the visualization post was built specifically so I could test these rules in isolation — write a rule, write a SPARQL query, see what the reasoner derives. The playground runs the query against the base data and against the data augmented by the rules side-by-side, so you can see exactly what the rules contributed.

# The zero hallucination claim

In the first post I mentioned "0% hallucination from LLMs, meaning every assertion must be backed up by sources." This is a strong claim and I want to be precise about what it means.

It means: for every factual assertion that the system returns to an LLM, there is a provenance trail — you can follow it to a specific source document, a specific chunk of text, and a specific extraction event with a confidence score and timestamp. The LLM can cite its sources because the graph requires sources for everything.

This is different from saying the extractions are always correct. An LLM can extract a wrong fact from a document and the system will faithfully store and return that wrong fact with high confidence. The system doesn't validate semantic correctness — it tracks origin. If the origin document is wrong or if the extraction was wrong, the provenance chain leads to the wrong source. You can then audit, retract, and correct.

The guarantee is not "everything in the graph is true". The guarantee is "everything in the graph was explicitly extracted from a named source, and you can look it up". That's a meaningful guarantee — it's the difference between a hallucinating AI and an AI that makes verifiable claims. Verifiable claims can be wrong and then corrected. Hallucinations can't be corrected because they have no ground truth to check against.

# What's missing: the SPARQL-to-SQL layer

One direction I explored but didn't fully implement is SPARQL-to-SQL query rewriting. The idea is that a query expressed in SPARQL against the ontology should be automatically translatable into an equivalent SQL query against the original relational database, using the R2RML binding layer as the translation map.

The benefit is that you'd get a single unified semantic query interface. An AI could write a SPARQL query using the ontology terms and get answers from either the RDF store or the SQL database transparently, depending on where the data lives.

I experimented with this for the insurance benchmark dataset (a structured set of policy, claim, and customer tables) and it's an interesting problem. Ontop is a tool that implements this kind of virtual knowledge graph — it takes SPARQL queries and rewrites them to SQL using R2RML mappings. My benchmark showed that Ontop could handle many of the standard SPARQL patterns, but complex joins and aggregations involving multiple hop patterns get tricky fast.

For the BigQuery datasets I ended up going with the semantic binding approach I described in part 6 instead — giving the LLM enough context to write SQL directly. It's less formally elegant than SPARQL-to-SQL but more practical for the LLM-first world where the AI generates queries anyway. If the AI is already generating SQL, having a SPARQL translation layer in between doesn't add much.

In a traditional enterprise setting where you'd have existing SPARQL tooling and BI tools wanting to query through the ontology, the formal SPARQL-to-SQL approach would be essential. For AI-native consumption, the semantic binding layer plus LLM-generated SQL is probably simpler.
