---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 6: Dealing with Structured Data
---

<br>

# The structured data problem

Most enterprise knowledge management systems have to deal with two kinds of data: unstructured documents (reports, articles, PDFs, emails) and structured relational data (databases, spreadsheets, data warehouses). The previous posts dealt with unstructured data — that's the indexing pipeline, entity extraction, normalization. But structured data is a completely different animal and it needs its own strategy.

For this proof of concept I'm working with public datasets in Google BigQuery: the American Community Survey (census income and demographics at the county level), the Opportunity Atlas (Raj Chetty's intergenerational mobility data at the tract level), and BLS QCEW employment data by industry sector. These are large, structured datasets with clear schemas, millions of rows, and well-defined column meanings.

The naive approach would be to lift all of this data into the RDF graph as triples. For the ACS dataset alone you'd be talking about hundreds of millions of triples just to represent 200+ columns for 3,000+ counties across several years. This would immediately blow past any practical scale limit for a personal proof of concept. Even at enterprise scale, doing a full copy of structured data into a triplestore is usually a bad idea — you're now running two stores of the same data, keeping them in sync, and paying twice for storage.

# The semantic binding layer

The approach I took instead is what I call a semantic binding layer. The idea is simple: instead of copying the data into the graph, I annotate the RDF entities with enough metadata that an AI can figure out how to query the original relational data at query time.

In practice this means: a County entity in the graph has a `fipsCode` property (e.g., "53033" for King County, WA). The binding layer says: "if you want to know about this county's median household income, here's the BigQuery table where that lives, here's the column schema, here's how to join using the fips code, and here are some example queries to get you started." The AI reads this context and generates a SQL query. The SQL query runs against BigQuery. The answer comes back.

No data is copied. No sync is required. The binding layer is just metadata — a YAML file that describes the tables, their columns, and example queries.

# What the binding actually looks like

The binding file for the economic census dataset describes six BigQuery tables: county-level ACS 1-year estimates, county-level ACS 5-year estimates (for smaller counties), state-level ACS, Opportunity Atlas outcomes, Opportunity Atlas structural covariates, and BLS QCEW employment data. For each table I specify:

- Which BigQuery project and table to query
- A description of what the table contains and when to use it
- The key columns with their types and what they mean in plain English
- How to join the table to RDF entities (which property carries the join key)
- Example SQL queries for common intents

The join key is the FIPS code — a 5-digit identifier for US counties (or 2-digit for states). The RDF entity carries `ex:fipsCode "53033"` as a literal property. The binding layer says the join expression is `SUBSTR(geo_id, -5)` for ACS tables or `geoid` for BLS tables. When the AI writes a query, it knows to extract the fips code from the entity and plug it into the appropriate join expression.

# Why this is better than a full ETL

There are a few reasons I like this approach:

**Currency**: BigQuery public datasets are updated. If the census data is refreshed, you automatically get fresh answers without re-indexing anything. A full ETL copy would be stale the moment it finishes.

**Scale**: BigQuery is built to handle the analytical queries you actually want to run against this data — aggregations across thousands of counties, joins across multiple tables, ranking queries. Doing that at scale inside a SPARQL triplestore would be painful. Let BigQuery do what it's good at.

**Separation of concerns**: The RDF graph owns the *semantic layer* — entity identity, relationships, provenance, annotations, ontology. BigQuery owns the *measurement layer* — time series, raw census numbers, industry statistics. These are different concerns and different tools are better suited to each.

**No triple explosion**: The alternative would be to represent every census measurement as an RDF statistical observation triple. For every county, every year, every column — that's easily tens of millions of triples just for the ACS data. And you'd have to maintain them, version them, handle updates.

# What the query flow looks like

When an AI is querying the knowledge graph and encounters a county entity, the flow goes something like this: the MCP tool retrieves the entity from the graph, including its fipsCode. It then checks whether the dataset has a BigQuery binding. If it does, it appends the binding context (table descriptions, schemas, example queries) to the LLM prompt. The LLM generates a SQL query, the query runs against BigQuery, and the structured results come back alongside the semantic data from the graph.

In practice this means you can ask questions like "what's the median household income in counties where the public health literature mentions high diabetes prevalence?" The graph handles the semantic part — entity relationships, document provenance, what the literature says. BigQuery handles the measurement part — actual census numbers. The AI stitches them together.

I should be honest that this is the most speculative part of the system. I built the binding layer and the context-building code, but the full query-time integration with an MCP tool is not completely done. It's more of a "phase 2" thing. But the architectural decision — don't copy structured data into the graph, use semantic binding instead — I think is the right one.

# The insight about different data granularities

One thing that struck me while building this is that different data sources operate at different granularities, and the graph is actually a natural place to handle that.

The Opportunity Atlas data is at census tract level (there are ~74,000 census tracts in the US). The ACS county data is at county level. BLS data is also at county level. The RDF graph can hold entities at all of these levels and relate them to each other (a census tract belongs to a county, a county belongs to a state). When the AI queries, it can choose the right granularity based on what the question requires — and the graph provides the traversal path to connect them.

This is an example of the semantic layer earning its keep: the relational databases treat each table independently, with FIPS codes as join keys. The graph explicitly models the containment relationships. "Show me all census tracts in King County" is a graph traversal. "Show me the income data for those tracts" is a SQL query against BigQuery using the fips codes of those tracts.

The combination is more powerful than either system alone.
