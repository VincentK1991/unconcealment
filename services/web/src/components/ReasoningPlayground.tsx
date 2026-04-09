import { useState, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SparqlResults {
  head: { vars: string[] };
  results: { bindings: Record<string, { type: string; value: string; "xml:lang"?: string }>[] };
}

interface PlaygroundResults {
  queryResults: SparqlResults;
  baseResults: SparqlResults;
}

type ResultTab = "table" | "graph" | "turtle";

interface ExamplePreset {
  id: string;
  label: string;
  description: string;
  rules: string;
  query: string;
}

interface PatternExample {
  id: string;
  label: string;
}

interface PatternGroup {
  id: string;
  label: string;
  notation: string;
  description: string;
  usefulness: string;
  examples: PatternExample[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const iriTail = (iri: string): string => iri.split(/[/#]/).pop() ?? iri;

// ── Diff helpers ──────────────────────────────────────────────────────────────

type Binding = Record<string, { type: string; value: string; "xml:lang"?: string }>;

/** Canonical key for a result row — used to test set membership. */
function rowKey(vars: string[], row: Binding): string {
  return vars.map((v) => `${v}=${row[v]?.value ?? ""}`).join("|");
}

/** Returns rows present in `inferred` but absent from `base`. */
function computeDiff(vars: string[], baseBindings: Binding[], inferredBindings: Binding[]): Binding[] {
  const baseSet = new Set(baseBindings.map((r) => rowKey(vars, r)));
  return inferredBindings.filter((r) => !baseSet.has(rowKey(vars, r)));
}

// ── Turtle serialization from ?s ?p ?o bindings ───────────────────────────────

function bindingsToTurtle(vars: string[], rows: Binding[]): string | null {
  if (!vars.includes("s") || !vars.includes("p") || !vars.includes("o")) return null;
  return rows
    .map((row) => {
      const s = row.s?.type === "uri" ? `<${row.s.value}>` : null;
      const p = row.p?.type === "uri" ? `<${row.p.value}>` : null;
      if (!s || !p) return null;
      const obj = row.o;
      let o: string;
      if (!obj) return null;
      if (obj.type === "uri") {
        o = `<${obj.value}>`;
      } else {
        const escaped = obj.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
        const lang = obj["xml:lang"];
        o = lang ? `"${escaped}"@${lang}` : `"${escaped}"`;
      }
      return `${s} ${p} ${o} .`;
    })
    .filter(Boolean)
    .join("\n");
}

// ── Graph types for react-force-graph-2d ──────────────────────────────────────

interface FGNode {
  id: string;
  label: string;
  isLiteral: boolean;
  x?: number;
  y?: number;
}

interface FGLink {
  source: string | FGNode;
  target: string | FGNode;
  label: string;
}

function buildGraphData(vars: string[], rows: Binding[]): { nodes: FGNode[]; links: FGLink[] } | null {
  if (!vars.includes("s") || !vars.includes("p") || !vars.includes("o")) return null;
  const nodeMap = new Map<string, FGNode>();
  const links: FGLink[] = [];

  const ensureNode = (id: string, isLiteral: boolean) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, label: isLiteral ? id.slice(0, 40) : iriTail(id), isLiteral });
    }
  };

  for (const row of rows) {
    if (!row.s || !row.p || !row.o) continue;
    const sId = row.s.value;
    const oId = row.o.type === "uri" ? row.o.value : `"${row.o.value.slice(0, 40)}"`;
    ensureNode(sId, row.s.type !== "uri");
    ensureNode(oId, row.o.type !== "uri");
    links.push({ source: sId, target: oId, label: iriTail(row.p.value) });
  }

  return { nodes: Array.from(nodeMap.values()), links };
}

// ── Verified example presets ──────────────────────────────────────────────────

const EXAMPLE_PRESETS: ExamplePreset[] = [
  {
    id: "coAuthor",
    label: "coAuthor",
    description: "Backward rule: two Person entities are co-authors if they both authored the same document via authoredBy.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
-> table(<http://localhost:4321/ontology/coAuthor>).

[coAuthor:
  (?author1 <http://localhost:4321/ontology/coAuthor> ?author2)
  <- (?object <http://localhost:4321/ontology/authoredBy> ?author1),
     (?object <http://localhost:4321/ontology/authoredBy> ?author2),
     (?author1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/Person>),
     (?author2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/Person>),
     notEqual(?author1, ?author2)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?sLabel ?p ?oLabel
WHERE {
  ?s ex:coAuthor ?o .
  OPTIONAL { ?s rdfs:label ?sLabel . }
  OPTIONAL { ?o rdfs:label ?oLabel . }
  BIND(ex:coAuthor AS ?p)
}
ORDER BY ?sLabel ?oLabel
LIMIT 20`,
  },
  {
    id: "trend-observation",
    label: "TrendObservation type",
    description: "Type inference: StatisticalObservations that track year-over-year change are reclassified as TrendObservation — a new type absent from the base graph.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Type / Class Inference: class membership + property presence → new rdf:type.
# rdf:type appears in both head and body, so Jena requires it to be tabled.
-> table(<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>).

[trendObservation:
  (?obs <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/TrendObservation>)
  <- (?obs <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalObservation>),
     (?obs <http://localhost:4321/ontology/changeDirection> ?dir)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?label ?dir ?geoLabel ?measureLabel
WHERE {
  ?obs rdf:type ex:TrendObservation ;
       ex:changeDirection ?dir .
  OPTIONAL { ?obs rdfs:label ?label }
  OPTIONAL { ?obs ex:refersToGeography ?geo . ?geo rdfs:label ?geoLabel }
  OPTIONAL { ?obs ex:measures ?m . ?m rdfs:label ?measureLabel }
}
ORDER BY ?label
LIMIT 20`,
  },
  {
    id: "geo-has-measure",
    label: "geo hasMeasure",
    description: "Property bridge: geographic areas gain a direct hasMeasure link by traversing observation→refersToGeography and observation→measures.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Property bridge: two different predicates on the same observation node
# produce a new direct predicate between geography and measure.
# hasMeasure does not exist in the base graph — all results are inferred.
# Type guards required: ex:measures has bad extractions (States, Observations)
# typed as measures; guarding on StatisticalMeasure filters them out.
[geoHasMeasure:
  (?geo <http://localhost:4321/ontology/hasMeasure> ?measure)
  <- (?obs <http://localhost:4321/ontology/refersToGeography> ?geo),
     (?obs <http://localhost:4321/ontology/measures> ?measure),
     (?measure <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalMeasure>)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?sLabel ?p ?oLabel
WHERE {
  ?s ex:hasMeasure ?o .
  OPTIONAL { ?s rdfs:label ?sLabel }
  OPTIONAL { ?o rdfs:label ?oLabel }
  BIND(ex:hasMeasure AS ?p)
}
ORDER BY ?sLabel ?oLabel
LIMIT 20`,
  },
  {
    id: "apportionment-derivedFrom",
    label: "apportionment derivedFrom",
    description: "Recursive backward rule: 2020 Census Apportionment follows derivedFrom chains, but only when the terminal node is an Organization.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
-> table(<http://localhost:4321/ontology/derivedFrom>).

[apportionmentDerivedFrom:
  (?a <http://localhost:4321/ontology/derivedFrom> ?c)
  <- (?a <http://localhost:4321/ontology/derivedFrom> ?b),
     (?b <http://localhost:4321/ontology/derivedFrom> ?c),
     (?c <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/Organization>),
     notEqual(?a, ?c)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?sLabel ("derivedFrom" AS ?pLabel) ?oLabel
WHERE {
  ?s ex:derivedFrom ?o .
  ?s rdfs:label ?sLabel .
  FILTER(CONTAINS(LCASE(STR(?sLabel)), "apportionment"))

  OPTIONAL { ?o rdfs:label ?oLabel }
}
ORDER BY ?oLabel ?o
LIMIT 200`,
  },
  {
    id: "reportedIn-transitive",
    label: "reportedIn chain",
    description: "Transitive backward rule: observations reported in a survey inherit a direct link to the survey's parent report document.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Transitive closure: Observation→Survey→Report collapses to Observation→Report.
# Type guards keep the rule semantically clean — avoids Survey→Organization chains.
-> table(<http://localhost:4321/ontology/reportedIn>).

[reportedInTransitive:
  (?a <http://localhost:4321/ontology/reportedIn> ?c)
  <- (?a <http://localhost:4321/ontology/reportedIn> ?b),
     (?b <http://localhost:4321/ontology/reportedIn> ?c),
     (?b <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/CensusSurvey>),
     (?c <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/ReportDocument>),
     notEqual(?a, ?c)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?aLabel ?aType ?cLabel
WHERE {
  ?a ex:reportedIn ?c .
  ?a rdfs:label ?aLabel .
  ?c a ex:ReportDocument .
  OPTIONAL { ?a a ?aType }
  OPTIONAL { ?c rdfs:label ?cLabel }
}
ORDER BY ?cLabel ?aLabel
LIMIT 20`,
  },
  {
    id: "quantified-indicator",
    label: "QuantifiedIndicator type",
    description: "Type inference: EconomicIndicators that carry an explicit hasValue are reclassified as QuantifiedIndicator — a new type absent from the base graph.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Type / Class Inference: base type + property presence → new rdf:type.
# rdf:type appears in both head and body — must be tabled.
-> table(<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>).

[quantifiedIndicator:
  (?e <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/QuantifiedIndicator>)
  <- (?e <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/EconomicIndicator>),
     (?e <http://localhost:4321/ontology/hasValue> ?v)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?label ?val ?year
WHERE {
  ?e rdf:type ex:QuantifiedIndicator ;
     ex:hasValue ?val .
  OPTIONAL { ?e rdfs:label ?label }
  OPTIONAL { ?e ex:forYear ?year }
}
ORDER BY ?year ?label
LIMIT 20`,
  },
  {
    id: "survey-yielded",
    label: "survey yielded",
    description: "Inverse property: derives CensusSurvey→yielded→StatisticalObservation as the reverse of the stored derivedFrom link. The yielded predicate does not exist in the base graph.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Inverse Property: reverse a stored directed link under a new predicate name.
# ex:yielded is brand-new — no tabling needed (no recursion risk).
[surveyYielded:
  (?survey <http://localhost:4321/ontology/yielded> ?obs)
  <- (?obs <http://localhost:4321/ontology/derivedFrom> ?survey),
     (?obs <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalObservation>),
     (?survey <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/CensusSurvey>)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?surveyLabel ?obsLabel
WHERE {
  ?survey ex:yielded ?obs .
  ?survey a ex:CensusSurvey .
  OPTIONAL { ?survey rdfs:label ?surveyLabel }
  OPTIONAL { ?obs rdfs:label ?obsLabel }
}
ORDER BY ?surveyLabel ?obsLabel
LIMIT 20`,
  },
  {
    id: "co-observation",
    label: "coObservation",
    description: "Symmetric role: two StatisticalObservations from the same CensusSurvey are inferred as co-observations of each other.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Symmetric / Mutual Role: shared source survey creates a peer link between observations.
# ex:coObservation is brand-new — no tabling needed.
[coObservation:
  (?a <http://localhost:4321/ontology/coObservation> ?b)
  <- (?a <http://localhost:4321/ontology/derivedFrom> ?survey),
     (?b <http://localhost:4321/ontology/derivedFrom> ?survey),
     (?a <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalObservation>),
     (?b <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalObservation>),
     (?survey <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/CensusSurvey>),
     notEqual(?a, ?b)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?aLabel ?bLabel
WHERE {
  ?a ex:coObservation ?b .
  OPTIONAL { ?a rdfs:label ?aLabel }
  OPTIONAL { ?b rdfs:label ?bLabel }
  FILTER(STR(?a) < STR(?b))
}
ORDER BY ?aLabel
LIMIT 20`,
  },
  {
    id: "inherit-group",
    label: "obs inherits group",
    description: "Property bridge with attribute inheritance: a StatisticalObservation inherits refersToGroup from its source CensusSurvey. Same predicate in head and body — requires tabling.",
    rules: `# Verified against /query/playground on the live economic-census dataset.
# Property Bridge: observation inherits a group reference from its source survey.
# refersToGroup appears in both head and body (different subjects) — must be tabled
# to prevent infinite backward recursion.
-> table(<http://localhost:4321/ontology/refersToGroup>).

[inheritGroup:
  (?obs <http://localhost:4321/ontology/refersToGroup> ?grp)
  <- (?obs <http://localhost:4321/ontology/derivedFrom> ?survey),
     (?survey <http://localhost:4321/ontology/refersToGroup> ?grp),
     (?obs <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/StatisticalObservation>),
     (?survey <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/CensusSurvey>),
     (?grp <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://localhost:4321/ontology/PopulationGroup>)]`,
    query: `PREFIX ex: <http://localhost:4321/ontology/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?obsLabel ?grpLabel
WHERE {
  ?obs ex:refersToGroup ?grp .
  ?obs a ex:StatisticalObservation .
  ?grp a ex:PopulationGroup .
  OPTIONAL { ?obs rdfs:label ?obsLabel }
  OPTIONAL { ?grp rdfs:label ?grpLabel }
}
ORDER BY ?obsLabel
LIMIT 20`,
  },
];

// ── Pattern groups ────────────────────────────────────────────────────────────

const PATTERN_GROUPS: PatternGroup[] = [
  {
    id: "transitive",
    label: "Transitive Closure",
    notation: "A→B, B→C ⊢ A→C (same predicate)",
    description:
      "A transitive rule propagates the same predicate across a chain of intermediate nodes. If A derives from B and B derives from C, the rule concludes A derives from C — collapsing multi-hop provenance into a direct link.",
    usefulness:
      "Exposes hidden lineage chains in provenance, organizational hierarchy, and citation graphs where intermediate hops obscure the terminal source.",
    examples: [
      { id: "apportionment-derivedFrom", label: "apportionment derivedFrom" },
      { id: "reportedIn-transitive", label: "reportedIn chain" },
    ],
  },
  {
    id: "mutual",
    label: "Symmetric / Mutual Role",
    notation: "A→Z, B→Z ⊢ A↔B (shared third entity)",
    description:
      "A symmetric role rule infers a bidirectional relationship between two entities that share a connection to a common third entity. If two people both authored the same document, they are co-authors of each other.",
    usefulness:
      "Discovers implicit peer relationships — co-authorship, co-membership, co-location — that are never stored explicitly but derivable from shared participation.",
    examples: [{ id: "coAuthor", label: "coAuthor" }],
  },
  {
    id: "bridge",
    label: "Property Bridge",
    notation: "A→B, B→C ⊢ A→C (different predicates, new result)",
    description:
      "A property bridge rule combines two different predicates on a shared intermediate node to produce a new direct predicate absent from the base graph. A geographic area gains a hasMeasure link by joining refersToGeography and measures through a shared observation node.",
    usefulness:
      "Shortcuts expensive multi-hop SPARQL traversals and enables faceted filtering on relationships that only exist through an intermediate join node.",
    examples: [
      { id: "geo-has-measure", label: "geo hasMeasure" },
      { id: "inherit-group", label: "obs inherits group" },
    ],
  },
  {
    id: "inverse",
    label: "Inverse Property",
    notation: "A→B ⊢ B→A (reverse arrow, new predicate name)",
    description:
      "An inverse rule creates a reverse link from the object back to the subject under a new predicate name. Only the forward direction is stored; the rule derives what navigation in the opposite direction would produce.",
    usefulness:
      "Models bidirectional access without duplicating storage at ingest time. The stored direction reflects how data was captured; the inferred direction reflects how users naturally browse.",
    examples: [{ id: "survey-yielded", label: "survey yielded" }],
  },
  {
    id: "type",
    label: "Type / Class Inference",
    notation: "type(X,C) + property(X) ⊢ type(X,D)",
    description:
      "A type inference rule assigns a new rdf:type to an entity when it has a base type and additionally satisfies a property condition. Statistical observations that carry a changeDirection property are reclassified as TrendObservations.",
    usefulness:
      "Enables class-based queries over subtypes never explicitly asserted, reducing the need for FILTER or UNION clauses across the query layer.",
    examples: [
      { id: "trend-observation", label: "TrendObservation type" },
      { id: "quantified-indicator", label: "QuantifiedIndicator type" },
    ],
  },
];

const EXAMPLE_MAP = new Map<string, ExamplePreset>(
  EXAMPLE_PRESETS.map((e) => [e.id, e])
);

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReasoningPlayground({ datasetId }: { datasetId: string }) {
  const [selectedPatternId, setSelectedPatternId] = useState<string>(PATTERN_GROUPS[0].id);
  const [selectedExampleId, setSelectedExampleId] = useState(PATTERN_GROUPS[0].examples[0].id);
  const [rules, setRules] = useState(EXAMPLE_MAP.get(PATTERN_GROUPS[0].examples[0].id)!.rules);
  const [query, setQuery] = useState(EXAMPLE_MAP.get(PATTERN_GROUPS[0].examples[0].id)!.query);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PlaygroundResults | null>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>("table");
  const [FGComponent, setFGComponent] = useState<any>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [graphDims, setGraphDims] = useState({ width: 600, height: 400 });

  // Dynamic import of react-force-graph-2d (no SSR)
  useEffect(() => {
    import("react-force-graph-2d").then((mod) => setFGComponent(() => mod.default));
  }, []);

  // Track graph container size
  useEffect(() => {
    const el = graphContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setGraphDims({ width, height: Math.max(height, 300) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(`/api/reasoning/${encodeURIComponent(datasetId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules, query }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setResults(data as PlaygroundResults);
        setActiveTab("table");
      }
    } catch (e: any) {
      setError(e.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const queryVars = results?.queryResults?.head?.vars ?? [];
  const queryBindings = results?.queryResults?.results?.bindings ?? [];
  const baseBindings = results?.baseResults?.results?.bindings ?? [];
  const diffRows = results ? computeDiff(queryVars, baseBindings, queryBindings) : [];
  const diffRowKeys = new Set(diffRows.map((row) => rowKey(queryVars, row)));
  const graphData = results ? buildGraphData(queryVars, diffRows) : null;
  const turtleText = results ? bindingsToTurtle(queryVars, diffRows) : null;

  const handleLoadExample = (example: ExamplePreset) => {
    setSelectedExampleId(example.id);
    setRules(example.rules);
    setQuery(example.query);
    setResults(null);
    setError(null);
    setActiveTab("table");
  };

  const handleSelectPattern = (patternId: string) => {
    const group = PATTERN_GROUPS.find((g) => g.id === patternId)!;
    setSelectedPatternId(patternId);
    handleLoadExample(EXAMPLE_MAP.get(group.examples[0].id)!);
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>

      {/* ── Pattern Group Tabs ── */}
      <div style={patternTabBarStyle}>
        {PATTERN_GROUPS.map((group) => (
          <button
            key={group.id}
            onClick={() => handleSelectPattern(group.id)}
            style={patternTabButtonStyle(group.id === selectedPatternId)}
          >
            {group.label}
          </button>
        ))}
      </div>

      {/* ── Active Pattern Panel ── */}
      {(() => {
        const group = PATTERN_GROUPS.find((g) => g.id === selectedPatternId)!;
        return (
          <div style={patternPanelStyle}>
            <div style={patternHeadingStyle}>{group.label}</div>
            <div style={notationPillStyle}>{group.notation}</div>
            <div style={patternDescriptionStyle}>{group.description}</div>
            <div style={patternUsefulnessLabelStyle}>Why it&apos;s useful</div>
            <div style={patternUsefulnessStyle}>{group.usefulness}</div>
            <div style={patternExampleRowStyle}>
              {group.examples.map((ex) => (
                <button
                  key={ex.id}
                  onClick={() => handleLoadExample(EXAMPLE_MAP.get(ex.id)!)}
                  style={patternExampleButtonStyle(ex.id === selectedExampleId)}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Editors ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>

        <div>
          <label style={labelStyle}>
            Rules
            <span style={hintStyle}>Jena rule syntax — recursive backward rules should declare `table(&lt;predicate&gt;)`</span>
          </label>
          <textarea
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            spellCheck={false}
            style={editorStyle}
            rows={10}
          />
        </div>

        <div>
          <label style={labelStyle}>
            SPARQL Query
            <span style={hintStyle}>SELECT query executed against the inferred graph</span>
          </label>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            style={editorStyle}
            rows={10}
          />
        </div>
      </div>

      <button
        onClick={handleRun}
        disabled={loading}
        style={runButtonStyle(loading)}
      >
        {loading ? "Running…" : "Run"}
      </button>

      {/* ── Error ── */}
      {error && (
        <div style={errorBoxStyle}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* ── Results ── */}
      {results && (
        <div style={{ marginTop: "1.5rem" }}>
          <div style={tabBarStyle}>
            {(["table", "graph", "turtle"] as ResultTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={tabButtonStyle(tab === activeTab)}
              >
                {tab === "table" && `Table (${queryBindings.length}${diffRows.length > 0 ? `, ${diffRows.length} new` : ""})`}
                {tab === "graph" && `Graph (${diffRows.length} new)`}
                {tab === "turtle" && "Raw Turtle"}
              </button>
            ))}
          </div>

          {/* Table */}
          {activeTab === "table" && (
            <div style={{ overflowX: "auto" }}>
              {queryBindings.length === 0 ? (
                <p style={emptyStyle}>No results returned by query.</p>
              ) : (
                <>
                  <div style={tableSummaryStyle}>
                    {diffRows.length > 0
                      ? `${diffRows.length} newly inferred row${diffRows.length === 1 ? "" : "s"} highlighted in green.`
                      : "No newly inferred rows in this result set."}
                  </div>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}></th>
                        {queryVars.map((v) => (
                          <th key={v} style={thStyle}>{v}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryBindings.map((row, i) => {
                        const isNew = diffRowKeys.has(rowKey(queryVars, row));
                        const background = isNew
                          ? i % 2 === 0 ? "#f0fdf4" : "#dcfce7"
                          : i % 2 === 0 ? "#fff" : "#fafafa";
                        return (
                          <tr key={i} style={{ background }}>
                            <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                              {isNew ? <span style={newBadgeStyle}>NEW</span> : null}
                            </td>
                            {queryVars.map((v) => (
                              <td key={v} style={tdStyle}>
                                {row[v]
                                  ? row[v].type === "uri"
                                    ? <span style={{ color: "#1a6bb5", fontFamily: "monospace", fontSize: "0.8rem" }}>{row[v].value}</span>
                                    : <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{row[v].value}</span>
                                  : <span style={{ color: "#bbb" }}>—</span>}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {/* Graph */}
          {activeTab === "graph" && (
            <div ref={graphContainerRef} style={{ border: "1px solid #e0e0e0", borderRadius: "6px", height: "420px", overflow: "hidden" }}>
              {!graphData ? (
                <p style={{ ...emptyStyle, paddingTop: "2rem" }}>
                  Graph view requires <code>?s</code>, <code>?p</code>, <code>?o</code> variables in your SELECT.
                </p>
              ) : diffRows.length === 0 ? (
                <p style={{ ...emptyStyle, paddingTop: "2rem" }}>No new rows to visualize — rules added nothing beyond the base graph.</p>
              ) : FGComponent ? (
                <FGComponent
                  graphData={graphData}
                  width={graphDims.width}
                  height={graphDims.height}
                  nodeLabel={(n: FGNode) => n.id}
                  nodeColor={(n: FGNode) => n.isLiteral ? "#f59e0b" : "#3b82f6"}
                  nodeRelSize={4}
                  linkLabel={(l: FGLink) => l.label}
                  linkDirectionalArrowLength={6}
                  linkDirectionalArrowRelPos={1}
                  linkColor={() => "#aaa"}
                  nodeCanvasObject={(node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
                    const label = node.label;
                    const fontSize = Math.max(10 / globalScale, 3);
                    const r = node.isLiteral ? 3 : 5;
                    ctx.beginPath();
                    ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
                    ctx.fillStyle = node.isLiteral ? "#f59e0b" : "#3b82f6";
                    ctx.fill();
                    ctx.font = `${fontSize}px sans-serif`;
                    ctx.fillStyle = "#222";
                    ctx.textAlign = "center";
                    ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + r + fontSize + 1);
                  }}
                />
              ) : (
                <p style={{ ...emptyStyle, paddingTop: "2rem" }}>Loading graph…</p>
              )}
            </div>
          )}

          {/* Raw Turtle */}
          {activeTab === "turtle" && (
            turtleText === null ? (
              <p style={emptyStyle}>
                Raw Turtle requires <code>?s</code>, <code>?p</code>, <code>?o</code> variables in your SELECT.
              </p>
            ) : diffRows.length === 0 ? (
              <p style={emptyStyle}>No new rows — rules produced nothing beyond the base graph.</p>
            ) : (
              <pre style={preStyle}>{turtleText}</pre>
            )
          )}

        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  fontSize: "0.85rem",
  marginBottom: "0.4rem",
};

const patternTabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "2px",
  padding: "4px",
  background: "#f0f0f0",
  borderRadius: "10px",
  marginBottom: "1rem",
  flexWrap: "wrap",
};

const patternTabButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.4rem 0.9rem",
  fontSize: "0.82rem",
  fontWeight: active ? 600 : 400,
  color: active ? "#1a6bb5" : "#555",
  background: active ? "#fff" : "transparent",
  border: active ? "1px solid #d0d8e4" : "1px solid transparent",
  borderRadius: "7px",
  cursor: "pointer",
  boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
  whiteSpace: "nowrap" as const,
});

const patternPanelStyle: React.CSSProperties = {
  padding: "1rem 1.1rem 1.1rem",
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  background: "#fcfcfc",
  marginBottom: "1rem",
};

const patternHeadingStyle: React.CSSProperties = {
  fontSize: "0.92rem",
  fontWeight: 700,
  color: "#222",
  margin: "0 0 0.55rem 0",
};

const notationPillStyle: React.CSSProperties = {
  display: "inline-block",
  fontFamily: '"SF Mono", "Fira Code", monospace',
  fontSize: "0.8rem",
  color: "#1a6bb5",
  background: "#eef6ff",
  border: "1px solid #c5ddf7",
  borderRadius: "5px",
  padding: "0.2rem 0.6rem",
  marginBottom: "0.65rem",
};

const patternDescriptionStyle: React.CSSProperties = {
  fontSize: "0.83rem",
  color: "#444",
  lineHeight: 1.55,
  marginBottom: "0.65rem",
};

const patternUsefulnessLabelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "#888",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  marginBottom: "0.3rem",
};

const patternUsefulnessStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  color: "#555",
  lineHeight: 1.5,
  marginBottom: "0.85rem",
};

const patternExampleRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const patternExampleButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.35rem 0.8rem",
  fontSize: "0.82rem",
  fontWeight: active ? 600 : 400,
  color: active ? "#1a6bb5" : "#444",
  background: active ? "#eef6ff" : "#fff",
  border: active ? "1px solid #1a6bb5" : "1px solid #d7d7d7",
  borderRadius: "6px",
  cursor: "pointer",
});

const hintStyle: React.CSSProperties = {
  fontWeight: 400,
  color: "#888",
  marginLeft: "0.5rem",
  fontSize: "0.78rem",
};

const editorStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontFamily: '"SF Mono", "Fira Code", monospace',
  fontSize: "0.82rem",
  padding: "0.6rem 0.75rem",
  border: "1px solid #d0d0d0",
  borderRadius: "6px",
  resize: "vertical",
  lineHeight: 1.5,
  color: "#222",
  background: "#fafafa",
};

const runButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: "0.45rem 1.4rem",
  background: disabled ? "#a0aec0" : "#1a6bb5",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  fontWeight: 500,
  cursor: disabled ? "default" : "pointer",
});

const errorBoxStyle: React.CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.75rem 1rem",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  color: "#b91c1c",
  fontSize: "0.875rem",
  fontFamily: "monospace",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 0,
  borderBottom: "2px solid #e0e0e0",
  marginBottom: "1rem",
};

const tabButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.45rem 1rem",
  fontSize: "0.85rem",
  background: "none",
  border: "none",
  borderBottom: active ? "2px solid #1a6bb5" : "2px solid transparent",
  marginBottom: "-2px",
  color: active ? "#1a6bb5" : "#555",
  fontWeight: active ? 600 : 400,
  cursor: "pointer",
});

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tableSummaryStyle: React.CSSProperties = {
  marginBottom: "0.55rem",
  fontSize: "0.8rem",
  color: "#666",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  background: "#f4f4f4",
  borderBottom: "1px solid #e0e0e0",
  fontWeight: 600,
  fontSize: "0.8rem",
  color: "#444",
};

const tdStyle: React.CSSProperties = {
  padding: "0.45rem 0.75rem",
  borderBottom: "1px solid #f0f0f0",
  verticalAlign: "top",
};

const preStyle: React.CSSProperties = {
  padding: "1rem",
  background: "#1e1e2e",
  color: "#cdd6f4",
  borderRadius: "6px",
  fontFamily: '"SF Mono", "Fira Code", monospace',
  fontSize: "0.82rem",
  overflowX: "auto",
  whiteSpace: "pre",
  lineHeight: 1.6,
};

const emptyStyle: React.CSSProperties = {
  color: "#888",
  fontSize: "0.9rem",
  textAlign: "center",
  padding: "1.5rem 0",
};

const newBadgeStyle: React.CSSProperties = {
  background: "#dcfce7",
  color: "#15803d",
  borderRadius: "4px",
  padding: "0.1rem 0.4rem",
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "0.05em",
  border: "1px solid #bbf7d0",
};
