import { useRef, useEffect, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphEdge {
  source: string;
  target: string;
  predicate: string;
}

export interface EntityGraphProps {
  entityIri: string;
  entityLabel: string;
  datasetId: string;
  seedEdges: GraphEdge[];
  seedIncoming: GraphEdge[];
  seedLabels: Record<string, string>;
  sameAsIris?: string[];
}

type NodeType = "central" | "sameAs" | "neighbor";

interface GraphNodeMeta {
  label: string;
  nodeType: NodeType;
  hopDegree: number; // 0 = central, 1-4 = BFS hop
}

interface StoredEdge extends GraphEdge {
  id: string;
}

interface GraphState {
  nodes: Map<string, GraphNodeMeta>;
  edges: Map<string, StoredEdge>;
  truncatedAtDegree: Set<number>;
}

// react-force-graph node/link types
interface FGNode {
  id: string;
  label: string;
  nodeType: NodeType;
  hopDegree: number;
  // mutated by force sim:
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface FGLink {
  source: string | FGNode;
  target: string | FGNode;
  label: string;
  isSameAs: boolean;
}

interface SparqlBinding {
  s?: { value: string };
  p?: { value: string };
  o?: { value: string; type?: string };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_CAP_PER_HOP = 500;
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

const CENTRAL_COLOR = "#f59e0b";
const SAME_AS_COLOR  = "#10b981";
// Degree 1-4 neighbor colors
const HOP_COLORS = ["", "#3b82f6", "#8b5cf6", "#06b6d4", "#f97316"] as const;

function nodeColor(node: FGNode): string {
  if (node.nodeType === "central") return CENTRAL_COLOR;
  if (node.nodeType === "sameAs")  return SAME_AS_COLOR;
  return HOP_COLORS[node.hopDegree] ?? HOP_COLORS[1];
}

const NODE_RADIUS: Record<NodeType, number> = {
  central: 9,
  sameAs:  7,
  neighbor: 5,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const iriTail = (iri: string): string => iri.split(/[/#]/).pop() ?? iri;

const buildEntityPath = (iri: string, datasetId: string): string => {
  if (iri.includes("/document/")) {
    return `/document/${encodeURIComponent(iriTail(iri))}?dataset=${encodeURIComponent(datasetId)}`;
  }
  return `/entity/${encodeURIComponent(datasetId)}/${encodeURIComponent(iriTail(iri))}`;
};

const edgeKey = (source: string, predicate: string, target: string): string =>
  `${source}||${predicate}||${target}`;

// ── SPARQL fetch ──────────────────────────────────────────────────────────────

async function fetchNeighborEdges(
  iris: string[],
  datasetId: string
): Promise<{ edges: GraphEdge[]; truncated: boolean }> {
  if (iris.length === 0) return { edges: [], truncated: false };

  const values = iris.map((i) => `<${i}>`).join(" ");
  const abox1 = `urn:${datasetId}:abox:asserted`;
  const abox2 = `urn:${datasetId}:abox:inferred`;
  const fetchLimit = NODE_CAP_PER_HOP + 1;

  const sparql = `
    SELECT DISTINCT ?s ?p ?o WHERE {
      {
        VALUES ?s { ${values} }
        GRAPH ?g { ?s ?p ?o . FILTER(isIRI(?o)) FILTER(?p != <${OWL_SAME_AS}>) }
        FILTER(?g IN (<${abox1}>, <${abox2}>))
      }
      UNION
      {
        VALUES ?o { ${values} }
        GRAPH ?g { ?s ?p ?o . FILTER(isIRI(?s)) FILTER(?p != <${OWL_SAME_AS}>) }
        FILTER(?g IN (<${abox1}>, <${abox2}>))
      }
    }
    LIMIT ${fetchLimit}
  `;

  try {
    const res = await fetch(`/api/sparql/${encodeURIComponent(datasetId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/sparql-query" },
      body: sparql,
    });
    if (!res.ok) return { edges: [], truncated: false };

    const data = (await res.json()) as {
      results?: { bindings?: SparqlBinding[] };
    };
    const bindings = data?.results?.bindings ?? [];
    const truncated = bindings.length >= fetchLimit;
    const capped = truncated ? bindings.slice(0, NODE_CAP_PER_HOP) : bindings;

    const edges: GraphEdge[] = capped
      .filter((b) => b.s?.value && b.p?.value && b.o?.value)
      .map((b) => ({ source: b.s!.value, predicate: b.p!.value, target: b.o!.value }));

    return { edges, truncated };
  } catch {
    return { edges: [], truncated: false };
  }
}

// ── Graph state builders ──────────────────────────────────────────────────────

function buildDegree1State(
  entityIri: string,
  entityLabel: string,
  seedEdges: GraphEdge[],
  seedIncoming: GraphEdge[],
  seedLabels: Record<string, string>,
  sameAsIris: string[]
): GraphState {
  const nodes = new Map<string, GraphNodeMeta>();
  const edges = new Map<string, StoredEdge>();

  nodes.set(entityIri, { label: entityLabel, nodeType: "central", hopDegree: 0 });

  // sameAs cluster — always part of the central super-node
  for (const iri of sameAsIris) {
    if (!nodes.has(iri)) {
      nodes.set(iri, {
        label: seedLabels[iri] ?? iriTail(iri),
        nodeType: "sameAs",
        hopDegree: 0,
      });
    }
    const id = edgeKey(entityIri, OWL_SAME_AS, iri);
    if (!edges.has(id)) {
      edges.set(id, { id, source: entityIri, target: iri, predicate: OWL_SAME_AS });
    }
  }

  const addEdge = (e: GraphEdge) => {
    if (!nodes.has(e.source)) {
      nodes.set(e.source, {
        label: seedLabels[e.source] ?? iriTail(e.source),
        nodeType: "neighbor",
        hopDegree: 1,
      });
    }
    if (!nodes.has(e.target)) {
      nodes.set(e.target, {
        label: seedLabels[e.target] ?? iriTail(e.target),
        nodeType: "neighbor",
        hopDegree: 1,
      });
    }
    const id = edgeKey(e.source, e.predicate, e.target);
    if (!edges.has(id)) edges.set(id, { ...e, id });
  };

  [...seedEdges, ...seedIncoming].forEach(addEdge);

  return { nodes, edges, truncatedAtDegree: new Set() };
}

function mergeHopIntoState(
  prev: GraphState,
  hopEdges: GraphEdge[],
  truncated: boolean,
  hopDegree: number
): GraphState {
  const nodes = new Map(prev.nodes);
  const edges = new Map(prev.edges);
  const truncatedAtDegree = new Set(prev.truncatedAtDegree);

  if (truncated) truncatedAtDegree.add(hopDegree);

  for (const e of hopEdges) {
    if (!nodes.has(e.source)) {
      nodes.set(e.source, { label: iriTail(e.source), nodeType: "neighbor", hopDegree });
    }
    if (!nodes.has(e.target)) {
      nodes.set(e.target, { label: iriTail(e.target), nodeType: "neighbor", hopDegree });
    }
    const id = edgeKey(e.source, e.predicate, e.target);
    if (!edges.has(id)) edges.set(id, { ...e, id });
  }

  return { nodes, edges, truncatedAtDegree };
}

function stateToGraphData(state: GraphState): { nodes: FGNode[]; links: FGLink[] } {
  const nodes: FGNode[] = Array.from(state.nodes.entries()).map(([id, meta]) => ({
    id,
    label: meta.label,
    nodeType: meta.nodeType,
    hopDegree: meta.hopDegree,
  }));

  const links: FGLink[] = [];
  const seenIds = new Set<string>();
  for (const [, edge] of state.edges.entries()) {
    if (!state.nodes.has(edge.source) || !state.nodes.has(edge.target)) continue;
    if (seenIds.has(edge.id)) continue;
    seenIds.add(edge.id);
    links.push({
      source: edge.source,
      target: edge.target,
      label: iriTail(edge.predicate),
      isSameAs: edge.predicate === OWL_SAME_AS,
    });
  }

  return { nodes, links };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EntityGraph({
  entityIri,
  entityLabel,
  datasetId,
  seedEdges,
  seedIncoming,
  seedLabels,
  sameAsIris = [],
}: EntityGraphProps) {
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [graphData, setGraphData] = useState<{ nodes: FGNode[]; links: FGLink[] }>({
    nodes: [],
    links: [],
  });
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [degree, setDegree] = useState(1);
  const [loading, setLoading] = useState(false);
  const [truncatedDegrees, setTruncatedDegrees] = useState<Set<number>>(new Set());
  const [FGComponent, setFGComponent] = useState<any>(null);

  const cacheRef = useRef<Map<number, GraphState>>(new Map());

  // Load react-force-graph-2d dynamically (avoids SSR issues)
  useEffect(() => {
    import("react-force-graph-2d").then((mod) => {
      setFGComponent(() => mod.default);
    });
  }, []);

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Configure d3 forces after the graph mounts
  const configureForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-400);
    fg.d3Force("link")?.distance((link: FGLink) => (link.isSameAs ? 55 : 130));
    fg.d3Force("center")?.strength(0.05);
  }, []);

  // ── BFS expansion ────────────────────────────────────────────────────────

  const centralCluster = useRef(new Set([entityIri, ...sameAsIris]));

  const expandToDegreee = useCallback(
    async (targetDegree: number): Promise<GraphState | null> => {
      if (!cacheRef.current.has(1)) {
        const d1 = buildDegree1State(
          entityIri, entityLabel, seedEdges, seedIncoming, seedLabels, sameAsIris
        );
        cacheRef.current.set(1, d1);
      }

      if (targetDegree === 1) return cacheRef.current.get(1)!;

      setLoading(true);
      try {
        for (let d = 2; d <= targetDegree; d++) {
          if (cacheRef.current.has(d)) continue;

          const prevState = cacheRef.current.get(d - 1)!;
          const frontier = Array.from(prevState.nodes.keys()).filter(
            (iri) => !centralCluster.current.has(iri)
          );

          const { edges: hopEdges, truncated } = await fetchNeighborEdges(frontier, datasetId);
          const next = mergeHopIntoState(prevState, hopEdges, truncated, d);
          cacheRef.current.set(d, next);
        }
      } finally {
        setLoading(false);
      }

      return cacheRef.current.get(targetDegree) ?? null;
    },
    [entityIri, entityLabel, datasetId, seedEdges, seedIncoming, seedLabels, sameAsIris]
  );

  // Bootstrap on mount
  useEffect(() => {
    const d1 = buildDegree1State(
      entityIri, entityLabel, seedEdges, seedIncoming, seedLabels, sameAsIris
    );
    cacheRef.current.set(1, d1);
    setGraphData(stateToGraphData(d1));
    centralCluster.current = new Set([entityIri, ...sameAsIris]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to degree changes
  useEffect(() => {
    if (cacheRef.current.has(degree)) {
      const state = cacheRef.current.get(degree)!;
      setTruncatedDegrees(new Set(state.truncatedAtDegree));
      setGraphData(stateToGraphData(state));
    } else {
      expandToDegreee(degree).then((state) => {
        if (!state) return;
        setTruncatedDegrees(new Set(state.truncatedAtDegree));
        setGraphData(stateToGraphData(state));
      });
    }
  }, [degree, expandToDegreee]);

  // ── Canvas drawing ────────────────────────────────────────────────────────

  const paintNode = useCallback((node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = NODE_RADIUS[node.nodeType];
    const color = nodeColor(node);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Dashed border for sameAs nodes
    if (node.nodeType === "sameAs") {
      ctx.save();
      ctx.strokeStyle = "#059669";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.restore();
    }

    // Label — only draw when zoomed in enough
    const fontSize = 11 / globalScale;
    if (fontSize > 2 && fontSize < 16) {
      const maxLen = 22;
      const label =
        node.label.length > maxLen ? node.label.slice(0, maxLen) + "…" : node.label;
      ctx.font = `${fontSize}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#444";
      ctx.fillText(label, x, y + r + 2);
    }
  }, []);

  const paintNodeArea = useCallback((node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
    const r = NODE_RADIUS[node.nodeType] + 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const handleNodeClick = useCallback(
    (node: FGNode) => {
      if (node.id !== entityIri) {
        window.open(buildEntityPath(node.id, datasetId), "_blank");
      }
    },
    [entityIri, datasetId]
  );

  const linkColor = useCallback(
    (link: FGLink) => (link.isSameAs ? "#10b981" : "#ccc"),
    []
  );

  const linkWidth = useCallback(
    (link: FGLink) => (link.isSameAs ? 2 : 1),
    []
  );

  const linkLineDash = useCallback(
    (link: FGLink) => (link.isSameAs ? [6, 3] : null),
    []
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: '"JetBrains Mono", "Fira Code", monospace' }}>
      {/* Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "10px",
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "#888", fontSize: "11px", marginRight: "2px", letterSpacing: "0.08em" }}>
          DEPTH
        </span>
        {([1, 2, 3, 4] as const).map((d) => {
          const active = degree === d;
          return (
            <button
              key={d}
              onClick={() => setDegree(d)}
              style={{
                padding: "3px 13px",
                borderRadius: "4px",
                border: `1px solid ${active ? "#1a6bb5" : "#ccc"}`,
                background: active ? "#eef3fb" : "#f8f8f8",
                color: active ? "#1a6bb5" : "#888",
                cursor: "pointer",
                fontWeight: active ? 700 : 400,
                fontSize: "13px",
                fontFamily: "inherit",
                transition: "all 0.12s",
              }}
            >
              {d}
            </button>
          );
        })}

        {loading && (
          <span style={{ color: "#1a6bb5", fontSize: "11px", marginLeft: "4px" }}>
            loading…
          </span>
        )}

        {truncatedDegrees.size > 0 && (
          <span
            style={{
              background: "#fffbe6",
              color: "#7c5e00",
              border: "1px solid #ffe58f",
              borderRadius: "10px",
              padding: "2px 10px",
              fontSize: "11px",
              marginLeft: "auto",
            }}
          >
            {NODE_CAP_PER_HOP}-node cap hit at depth{" "}
            {Array.from(truncatedDegrees).sort().join(", ")}
          </span>
        )}

        {/* Legend */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto", flexWrap: "wrap" }}>
          <LegendDot color={CENTRAL_COLOR} label="entity" />
          <LegendDot color={SAME_AS_COLOR} label="sameAs" dashed />
          {([1, 2, 3, 4] as const).slice(0, degree).map((d) => (
            <LegendDot key={d} color={HOP_COLORS[d]} label={`hop ${d}`} />
          ))}
        </div>
      </div>

      {/* Graph canvas */}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "calc(100vh - 220px)",
          minHeight: "560px",
          borderRadius: "6px",
          border: "1px solid #e5e5e5",
          overflow: "hidden",
          cursor: "grab",
        }}
      >
        {FGComponent && (
          <FGComponent
            ref={fgRef}
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            nodeId="id"
            nodeLabel="label"
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={paintNodeArea}
            onNodeClick={handleNodeClick}
            linkSource="source"
            linkTarget="target"
            linkLabel="label"
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={linkLineDash}
            linkDirectionalArrowLength={1}
            linkDirectionalArrowRelPos={1}
            onEngineStop={configureForces}
            warmupTicks={60}
            cooldownTicks={150}
            backgroundColor="rgba(0,0,0,0)"
          />
        )}
      </div>

      <p style={{ color: "#aaa", fontSize: "10px", margin: "7px 0 0", textAlign: "right", letterSpacing: "0.04em" }}>
        click node → open in new tab · scroll to zoom · drag to pan
      </p>
    </div>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
          outline: dashed ? `2px dashed ${color}` : undefined,
          outlineOffset: dashed ? "2px" : undefined,
        }}
      />
      <span style={{ color: "#888", fontSize: "10px" }}>{label}</span>
    </div>
  );
}
