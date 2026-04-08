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

type ResultTab = "table" | "graph" | "turtle" | "diff";

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

// ── Default editor content ────────────────────────────────────────────────────

const DEFAULT_RULES = `# Jena backward-chaining rule syntax
# Arrow direction: conclusion <- conditions
# Use full IRIs in angle brackets or prefixed names after @prefix declarations.
#
# Example: infer a symmetric relationship
[symmetry: (?b <http://www.w3.org/2002/07/owl#sameAs> ?a)
           <- (?a <http://www.w3.org/2002/07/owl#sameAs> ?b)]`;

const DEFAULT_QUERY = `SELECT ?s ?p ?o
WHERE {
  ?s ?p ?o .
}
LIMIT 20`;

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReasoningPlayground({ datasetId }: { datasetId: string }) {
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [query, setQuery] = useState(DEFAULT_QUERY);
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
  const graphData = results ? buildGraphData(queryVars, diffRows) : null;
  const turtleText = results ? bindingsToTurtle(queryVars, diffRows) : null;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>

      {/* ── Editors ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>

        <div>
          <label style={labelStyle}>
            Rules
            <span style={hintStyle}>Jena rule syntax — backward chaining, applied at query time</span>
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
            {(["table", "graph", "turtle", "diff"] as ResultTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={tabButtonStyle(tab === activeTab)}
              >
                {tab === "table" && `Table (${queryBindings.length})`}
                {tab === "graph" && `Graph (${diffRows.length} new)`}
                {tab === "turtle" && "Raw Turtle"}
                {tab === "diff" && `Diff (${diffRows.length} new)`}
              </button>
            ))}
          </div>

          {/* Table */}
          {activeTab === "table" && (
            <div style={{ overflowX: "auto" }}>
              {queryBindings.length === 0 ? (
                <p style={emptyStyle}>No results returned by query.</p>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      {queryVars.map((v) => (
                        <th key={v} style={thStyle}>{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryBindings.map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
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
                    ))}
                  </tbody>
                </table>
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

          {/* Diff */}
          {activeTab === "diff" && (
            diffRows.length === 0 ? (
              <p style={emptyStyle}>No new rows — the rules added nothing beyond what was already in the graph.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}></th>
                      {queryVars.map((v) => <th key={v} style={thStyle}>{v}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {diffRows.map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "#f0fdf4" : "#dcfce7" }}>
                        <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                          <span style={newBadgeStyle}>NEW</span>
                        </td>
                        {queryVars.map((v) => (
                          <td key={v} style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.78rem" }}>
                            {row[v]
                              ? row[v].type === "uri"
                                ? <span style={{ color: "#1a6bb5" }}>{iriTail(row[v].value)}</span>
                                : <span>"{row[v].value.slice(0, 80)}{row[v].value.length > 80 ? "…" : ""}"</span>
                              : <span style={{ color: "#bbb" }}>—</span>
                            }
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
