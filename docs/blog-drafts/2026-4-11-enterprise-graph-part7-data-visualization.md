---
layout: post
title: Context Graph, AI, Semantic layers, Ontology — Part 7: Data Visualization
---

<br>

# What does a knowledge graph look like to a human?

One of the questions I kept coming back to while building this is: how do you make a knowledge graph legible to someone who didn't build it? The backend is all SPARQL, RDF triples, named graphs, inference rules — none of which are friendly to humans who just want to understand what's in the system. The web interface is my answer to this.

I built the frontend using Astro with React Islands. Astro does server-side rendering for the static parts (navigation, layouts, entity metadata displayed as HTML) and React handles the interactive parts (the entity graph visualization, the SPARQL explorer, the normalization explorer). This setup is a nice balance — fast initial load because most of the page is server-rendered, interactive components where you actually need them.

# The entity page as the core unit

The fundamental unit of navigation in the UI is the entity page. Every entity in the graph has a page at `/entity/{dataset}/{uuid}`. This is meant to feel like a Wikipedia article for that entity. You land on a page, you see the entity's label, its type, a description if one was extracted, and a list of properties and relationships to other entities.

The entity page also shows which documents this entity was extracted from — with links to the original document. This is the provenance chain in action: you can click from an entity to the specific source document that first mentioned it. The document page shows the raw extracted text. This is the "zero hallucination" property I mentioned in the intro post: every assertion in the graph traces back to a source document.

One thing that took some thought was how to handle normalization on the entity page. If "King County, WA" and "King County, Washington" are linked by owl:sameAs, should they show as separate pages or the same page? I went with separate pages, but both pages show the sameAs cluster — you can see which entities this entity is considered equivalent to. The canonical entity has a special marker. Navigating to a non-canonical entity redirects you to the canonical one.

# The entity graph visualization

The most visually interesting part of the UI is the force-directed graph visualization on each entity page. I used react-force-graph-2d for this, which is a canvas-based force simulation library. The graph starts with the central entity (gold node) and its immediate neighbors (the entities it has direct relationships to). You can expand to depth 2, 3, or 4 with button clicks, fetching additional hops from the SPARQL backend.

The sameAs cluster members show up as dashed green nodes closely orbiting the central entity — they're collapsed visually to suggest they're part of the same conceptual thing but are technically different IRIs. Clicking any other node opens that entity in a new tab.

One implementation detail that I'm happy with: the graph data is cached per hop depth. So if you expand to depth 2, go back to depth 1, then back to depth 2, the second depth-2 expansion is instant — no network request. The cache lives in a React ref so it persists across renders without causing re-renders itself.

There's also a node cap — at most 500 nodes per hop. Highly connected entities can have thousands of neighbors and you don't want to load all of them into the browser at once. If the cap is hit, a warning badge appears: "500-node cap hit at depth 2". For this proof of concept the datasets were small enough that hitting the cap was rare, but in a real production system you'd want smarter pagination here.

# The normalization explorer

The normalization explorer is a UI for browsing the owl:sameAs clusters in the graph. For each cluster, you can see: which entity is canonical, all the variant entities that are equivalent, the confidence scores of each sameAs link, and which normalization method produced each link (exact-label, jaro-winkler, or llm-judge).

This is the administrative view — it lets you spot normalization decisions that look wrong. Maybe two entities got merged because their labels are similar but they're actually different things. The provenance annotation tells you the confidence and method, so you know whether to trust it. In a fuller system, there would be a way to manually correct a bad merge from this UI. I didn't build that part.

# The SPARQL explorer and SQL explorer

For users who want to go beyond the entity page, I built raw query explorers. The SPARQL explorer is a text area where you can write SPARQL queries against the backend directly. The results come back as a table. This is essentially a simplified Fuseki UI that lives inside the wiki.

The SQL explorer does the same thing but for BigQuery — you write SQL, it runs against the BigQuery tables defined in the binding layer, and you get results back. This is purely exploratory and doesn't touch the RDF graph at all, but it's useful for poking at the raw structured data.

Both explorers go through the Java backend, not directly to Fuseki or BigQuery. The backend handles authentication, query routing to the right named graph or reasoner mode, and any safety limits (like result set size caps).

# The reasoning playground

The reasoning playground is a UI for testing backward chaining rules. You write a SPARQL query that invokes the reasoner, and it shows you both the raw query results and an explanation of which rules fired to produce them. This was primarily a debugging tool during development — when a backward rule wasn't working as expected, I'd throw the query into the playground and see what the reasoner was doing with it.

In a more polished product this would be useful for ontology engineers who want to verify that rules are doing what they intended before deploying them. But in the proof of concept it's more of a developer convenience.

# What I think about the web frontend

The decision to use Astro was a good one. Astro's "islands architecture" — where React components are rendered as server-side HTML by default and only hydrate on the client when they actually need interactivity — fits well for a knowledge graph browser. Most of the entity page is static metadata that doesn't need JavaScript to render. Only the graph visualization and the query explorers need React's reactivity.

The force-directed graph visualization is the part I'm most uncertain about in terms of scalability. It looks great for small, well-connected subgraphs. It becomes chaotic and unnavigable when you expand too far on a highly connected entity. The Wikipedia approach of using simple linked text rather than a force graph probably scales better for human navigation. The graph visualization is more useful for understanding connectivity and discovering nearby entities than for actual navigation.

If I were to rebuild this, I'd probably invest more in the entity page's text presentation — better structured display of attributes, a better way to show temporal information (when was this fact valid?), a cleaner way to show the provenance chain. The graph is eye-catching but the structured text is more useful day to day.
