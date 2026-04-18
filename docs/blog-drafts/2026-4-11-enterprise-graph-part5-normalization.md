---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 5: Data Normalization
---

<br>

# The entity identity problem

Here's a scenario: you index a report that mentions "King County, WA". You then index another report that mentions "King County, Washington" and another that says "King County (WA)". Now you have three entities in the graph with different labels, all referring to the exact same place. An LLM querying the graph might traverse all three as if they were different places, or miss relationships attached to the other variants. This is the entity identity problem and it is one of the hardest parts of building a knowledge graph from unstructured data.

The naive solution is to just hard-merge them: pick one canonical label, point everything at it, delete the variants. This works until you have to undo it — which will happen. What if one of those variants was wrong? What if the merge was based on a bad heuristic? Now you've destroyed information. You have no record of what was merged, why, or with what confidence.

The approach I took instead is non-destructive normalization via owl:sameAs.

# owl:sameAs and why it helps

owl:sameAs is an OWL construct that says two URIs refer to the same real-world thing. If I assert that `entity:king-county-wa-1` owl:sameAs `entity:king-county-canonical`, and I'm running inference rules, then any query against the canonical entity automatically includes triples asserted against the variant, and vice versa. The reasoner closes over this symmetrically and transitively.

What this means in practice is that normalization is a set of curated decisions stored in a separate named graph (`urn:{dataset}:normalization`), not a destructive operation on the data. The variant entities still exist. Their original triples still exist. The normalization graph is an overlay that tells the reasoner how to treat them as equivalent.

This is a critical distinction from the inferred graph. The inferred graph is the output of forward chaining — it can be wiped and regenerated any time. The normalization graph contains intentional human (or LLM-mediated) decisions with provenance attached. It can never be automatically rebuilt from the raw data — it captures judgment calls about entity identity.

# The two-tier normalization strategy

For every new entity that comes in from an indexing run, the system tries to figure out if this entity already exists in the graph. I do this in two steps, running one after the other.

**Tier 1: Rule-based (Jaro-Winkler + Lucene)**

First, the system uses Jena-text (which is Apache Lucene under the hood) to retrieve candidate entities from the graph by fuzzy text match on rdfs:label. This gives you a shortlist of candidates that are textually similar to the new entity's label.

Then it computes Jaro-Winkler similarity between the normalized labels. Jaro-Winkler is a string similarity metric that's particularly good for short strings and names — it rewards common prefixes and handles transpositions better than edit distance for this kind of data.

If the score is at or above 0.92, the system writes an owl:sameAs link immediately. If the score is between 0.75 and 0.92 — the ambiguous middle zone — the pair is flagged as a candidate for the LLM step.

There's also an intra-batch dedup step. Within a single indexing run, the same entity might be extracted from multiple chunks of the same document. "King County, WA" appears in chunk 1, "King County Washington" in chunk 4. The system runs Jaro-Winkler pairwise across all entities extracted in the current run before even looking at the existing graph.

**Tier 2: LLM-as-judge**

For the medium-confidence pairs that come out of the rule-based step, the system sends them to GPT-4o in batches of 50. Each pair is described by the labels, types, and descriptions of both entities. The LLM returns a verdict: is this the same entity or not, with a confidence score.

The LLM has access to more context than the Jaro-Winkler score does — it can see that "King County, WA" and "King County (Washington)" have the same type (a geographic area) and similar descriptions, which together make it much clearer they're the same thing than the string similarity alone would indicate.

Pairs where the LLM says yes with confidence at or above 0.80 get an owl:sameAs link written to the normalization graph, with the method marked as "llm-judge". Low confidence or no answers get discarded.

The LLM step is non-fatal. If the model returns bad output or an API call fails for a batch, I log a warning and skip that batch. The document remains indexed — it just doesn't get normalized for those uncertain pairs, which is fine. You'd rather have un-merged entities than a crashed pipeline.

# Canonical election

Once sameAs pairs are written, the system needs to decide which entity in the cluster is the canonical one — the one that everything should be navigated through in the UI and queried against by the AI.

The election rule is simple: the entity with the highest in-degree in the sameAs graph (i.e., the one most frequently pointed to as the object of owl:sameAs assertions) is canonical. Ties are broken lexicographically by IRI. The winner gets an `ex:isCanonical true` marker written to the normalization graph.

This election runs incrementally — only clusters that contain at least one entity from the current indexing run are re-evaluated. This keeps it fast even as the graph grows.

# How it all flows through the reasoner

The forward-chaining reasoner picks up owl:sameAs symmetry and transitivity. So if you have:

```
entity:apple-inc-1   owl:sameAs  entity:apple-canonical
entity:apple-inc-2   owl:sameAs  entity:apple-canonical
```

Then the reasoner materializes:

```
entity:apple-canonical   owl:sameAs  entity:apple-inc-1
entity:apple-canonical   owl:sameAs  entity:apple-inc-2
entity:apple-inc-1       owl:sameAs  entity:apple-inc-2
```

...and importantly, any triple asserted against `entity:apple-inc-1` is also retrievable via a query against `entity:apple-canonical`. You don't have to think about which variant was used in which document. The reasoner makes them transparent.

# Provenance on normalization decisions

Every owl:sameAs triple in the normalization graph carries RDF-star annotations:
- `normalizationMethod`: "exact-label", "jaro-winkler", or "llm-judge"
- `confidence`: the score from the rule-based or LLM step
- `indexingRun`: the ID of the indexing run that produced this decision
- `transactionTime`: when the decision was made

This means if you want to audit why two entities were merged, you can query the normalization graph and see exactly what method produced the decision and when. And if an indexing run is rolled back, the rollback deletes exactly the sameAs triples introduced by that run, by filtering on the indexingRun annotation.

# What I think about this

The two-tier approach works well in my testing. Exact matches and clearly-the-same-string entities get handled cheaply by Jaro-Winkler. The genuinely ambiguous cases — where the label is somewhat similar but you need context to decide — go to the LLM. This keeps LLM costs down while still handling the hard cases.

One thing I'm uncertain about is the thresholds. 0.92 for high confidence and 0.75 for medium are empirically chosen. I don't have a good theoretical justification for them. In a production system you'd want to calibrate these against labeled data. For the proof of concept, they felt right for the kinds of entities I was seeing (geographic names, survey names, demographic measures).

The non-destructive approach is essential and I feel strongly about it. Entities in a knowledge graph should be stable. Normalization decisions should be auditable and reversible. Hard merges are a trap — they look clean until you need to undo one. The owl:sameAs approach keeps everything clean without sacrificing correctness.

One limitation of the current system is that the normalization runs per-document. If you index 10,000 documents, normalization runs 10,000 times, each time looking at entities introduced in that run. This is efficient for the incremental case but doesn't do a full global dedup pass. In principle you'd also want a periodic batch dedup that looks at all entities in the graph and finds pairs the per-document step might have missed. I haven't implemented that yet.
