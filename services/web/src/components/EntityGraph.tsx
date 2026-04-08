import { useRef, useEffect, useState, useCallback } from "react";
import type cytoscape from "cytoscape";

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
}

interface GraphState {
  nodes: Map<string, GraphNodeMeta>;
  edges: Map<string, GraphEdge & { id: string }>;
  truncatedAtDegree: Set<number>;
}

interface SparqlBinding {
  s?: { value: string };
  p?: { value: string };
  o?: { value: string; type?: string };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_CAP_PER_HOP = 500;
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

const DEGREE_BUTTON_STYLES = {
  active: {
    borderColor: "#1a6bb5",
    background: "#eef3fb",
    color: "#1a6bb5",
    fontWeight: 700,
  },
  inactive: {
    borderColor: "#ccc",
    background: "#f8f8f8",
    color: "#888",
    fontWeight: 400,
  },
} as const;

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
  const sameAs = "http://www.w3.org/2002/07/owl#sameAs";
  const fetchLimit = NODE_CAP_PER_HOP + 1;

  const sparql = `
    SELECT DISTINCT ?s ?p ?o WHERE {
      {
        VALUES ?s { ${values} }
        GRAPH ?g { ?s ?p ?o . FILTER(isIRI(?o)) FILTER(?p != <${sameAs}>) }
        FILTER(?g IN (<${abox1}>, <${abox2}>))
      }
      UNION
      {
        VALUES ?o { ${values} }
        GRAPH ?g { ?s ?p ?o . FILTER(isIRI(?s)) FILTER(?p != <${sameAs}>) }
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
      .map((b) => ({
        source: b.s!.value,
        predicate: b.p!.value,
        target: b.o!.value,
      }));

    return { edges, truncated };
  } catch {
    return { edges: [], truncated: false };
  }
}

// ── Build/merge graph state ───────────────────────────────────────────────────

function buildDegree1State(
  entityIri: string,
  entityLabel: string,
  seedEdges: GraphEdge[],
  seedIncoming: GraphEdge[],
  seedLabels: Record<string, string>,
  sameAsIris: string[]
): GraphState {
  const nodes = new Map<string, GraphNodeMeta>();
  const edges = new Map<string, GraphEdge & { id: string }>();

  nodes.set(entityIri, { label: entityLabel, nodeType: "central" });

  // Add sameAs cluster nodes and edges first (always shown regardless of degree)
  for (const iri of sameAsIris) {
    if (!nodes.has(iri)) {
      nodes.set(iri, {
        label: seedLabels[iri] ?? iriTail(iri),
        nodeType: "sameAs",
      });
    }
    const e: GraphEdge = { source: entityIri, target: iri, predicate: OWL_SAME_AS };
    const id = edgeKey(e.source, e.predicate, e.target);
    if (!edges.has(id)) edges.set(id, { ...e, id });
  }

  const addEdge = (e: GraphEdge) => {
    if (!nodes.has(e.source)) {
      nodes.set(e.source, {
        label: seedLabels[e.source] ?? iriTail(e.source),
        nodeType: "neighbor",
      });
    }
    if (!nodes.has(e.target)) {
      nodes.set(e.target, {
        label: seedLabels[e.target] ?? iriTail(e.target),
        nodeType: "neighbor",
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
      nodes.set(e.source, { label: iriTail(e.source), nodeType: "neighbor" });
    }
    if (!nodes.has(e.target)) {
      nodes.set(e.target, { label: iriTail(e.target), nodeType: "neighbor" });
    }
    const id = edgeKey(e.source, e.predicate, e.target);
    if (!edges.has(id)) edges.set(id, { ...e, id });
  }

  return { nodes, edges, truncatedAtDegree };
}

// ── Cytoscape render ─────────────────────────────────────────────────────────

function applyStateToCytoscape(cy: cytoscape.Core, state: GraphState): void {
  cy.startBatch();
  cy.elements().remove();

  const nodeEls: cytoscape.ElementDefinition[] = [];
  for (const [iri, meta] of state.nodes.entries()) {
    nodeEls.push({
      data: { id: iri, label: meta.label, nodeType: meta.nodeType },
    });
  }

  const edgeEls: cytoscape.ElementDefinition[] = [];
  const seenEdgeIds = new Set<string>();
  for (const [, edge] of state.edges.entries()) {
    if (!state.nodes.has(edge.source) || !state.nodes.has(edge.target)) continue;
    if (seenEdgeIds.has(edge.id)) continue;
    seenEdgeIds.add(edge.id);
    edgeEls.push({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: iriTail(edge.predicate),
        sameAs: edge.predicate === OWL_SAME_AS ? "1" : "0",
      },
    });
  }

  cy.add([...nodeEls, ...edgeEls]);
  cy.endBatch();

  (
    cy.layout({
      name: "cose",
      animate: true,
      animationDuration: 800,
      randomize: true,
      nodeRepulsion: 12000,
      idealEdgeLength: (edge: cytoscape.EdgeSingular) =>
        edge.data("sameAs") === "1" ? 55 : 160,
      edgeElasticity: 200,
      gravity: 0.05,
      numIter: 2000,
      initialTemp: 500,
      coolingFactor: 0.97,
      minTemp: 1.0,
      fit: true,
      padding: 48,
      componentSpacing: 120,
    } as cytoscape.LayoutOptions)
  ).run();
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
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const [degree, setDegree] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [truncatedDegrees, setTruncatedDegrees] = useState<Set<number>>(
    new Set()
  );

  // Degree → accumulated GraphState cache
  const cacheRef = useRef<Map<number, GraphState>>(new Map());

  // ── Expand cache to targetDegree ─────────────────────────────────────────

  const expandToDegreee = useCallback(
    async (targetDegree: number): Promise<GraphState | null> => {
      // Ensure degree-1 is bootstrapped
      if (!cacheRef.current.has(1)) {
        const d1 = buildDegree1State(
          entityIri,
          entityLabel,
          seedEdges,
          seedIncoming,
          seedLabels,
          sameAsIris
        );
        cacheRef.current.set(1, d1);
      }

      if (targetDegree === 1) return cacheRef.current.get(1)!;

      // The central cluster (entityIri + sameAs peers) is the degree-0 super-node.
      // Exclude them from all BFS frontiers so they don't generate additional hops.
      const centralCluster = new Set([entityIri, ...sameAsIris]);

      setLoading(true);
      try {
        for (let d = 2; d <= targetDegree; d++) {
          if (cacheRef.current.has(d)) continue;

          const prevState = cacheRef.current.get(d - 1)!;
          // Frontier = nodes added at previous degree, excluding the central cluster
          const frontier = Array.from(prevState.nodes.keys()).filter(
            (iri) => !centralCluster.has(iri)
          );

          const { edges: hopEdges, truncated } = await fetchNeighborEdges(
            frontier,
            datasetId
          );

          const next = mergeHopIntoState(prevState, hopEdges, truncated, d);
          cacheRef.current.set(d, next);
        }
      } finally {
        setLoading(false);
      }

      return cacheRef.current.get(targetDegree) ?? null;
    },
    [entityIri, entityLabel, datasetId, seedEdges, seedIncoming, seedLabels]
  );

  // ── Initialize Cytoscape on mount ────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    let alive = true;

    import("cytoscape").then(({ default: Cytoscape }) => {
      if (!alive || !containerRef.current) return;

      const cy = Cytoscape({
        container: containerRef.current,
        elements: [],
        style: [
          {
            selector: "node",
            style: {
              "background-color": "#3b82f6",
              label: "data(label)",
              color: "#333",
              "font-size": "10px",
              "font-family": '"JetBrains Mono", "Fira Code", "Courier New", monospace',
              "text-valign": "bottom",
              "text-halign": "center",
              "text-margin-y": 5,
              width: 28,
              height: 28,
              "border-width": 1.5,
              "border-color": "#1d4ed8",
              "text-max-width": "100px",
              "text-wrap": "ellipsis",
              "overlay-opacity": 0,
            } as Record<string, unknown>,
          },
          {
            selector: "node[nodeType='central']",
            style: {
              "background-color": "#f59e0b",
              "border-color": "#b45309",
              "border-width": 3,
              width: 46,
              height: 46,
              "font-size": "12px",
              "font-weight": "bold",
              color: "#fff",
            } as Record<string, unknown>,
          },
          {
            selector: "node[nodeType='sameAs']",
            style: {
              "background-color": "#10b981",
              "border-color": "#059669",
              "border-width": 2,
              "border-style": "dashed",
              width: 36,
              height: 36,
              "font-size": "10px",
              "font-weight": "bold",
              color: "#fff",
            } as Record<string, unknown>,
          },
          {
            selector: "node:hover",
            style: {
              "border-width": 3,
              "border-color": "#93c5fd",
              "overlay-opacity": 0,
            } as Record<string, unknown>,
          },
          {
            selector: "edge",
            style: {
              width: 1.5,
              "line-color": "#bbb",
              "target-arrow-color": "#999",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              label: "data(label)",
              "font-size": "8px",
              "font-family": '"JetBrains Mono", "Fira Code", "Courier New", monospace',
              color: "#999",
              "text-rotation": "autorotate",
              "text-margin-y": -7,
              opacity: 0.8,
            } as Record<string, unknown>,
          },
          {
            selector: "edge[sameAs='1']",
            style: {
              width: 2.5,
              "line-color": "#10b981",
              "line-style": "dashed",
              "line-dash-pattern": [8, 4],
              "target-arrow-color": "#10b981",
              "target-arrow-shape": "triangle",
              color: "#10b981",
              "font-weight": "bold",
              opacity: 1,
            } as Record<string, unknown>,
          },
        ],
        minZoom: 0.1,
        maxZoom: 6,
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
      });

      cy.on("tap", "node", (evt) => {
        const iri: string = evt.target.id();
        if (iri !== entityIri) {
          window.open(buildEntityPath(iri, datasetId), "_blank");
        }
      });

      cy.on("mouseover", "node", () => {
        if (containerRef.current) containerRef.current.style.cursor = "pointer";
      });
      cy.on("mouseout", "node", () => {
        if (containerRef.current) containerRef.current.style.cursor = "default";
      });

      cyRef.current = cy;

      // Bootstrap degree-1
      const d1 = buildDegree1State(
        entityIri,
        entityLabel,
        seedEdges,
        seedIncoming,
        seedLabels,
        sameAsIris
      );
      cacheRef.current.set(1, d1);
      applyStateToCytoscape(cy, d1);
    });

    return () => {
      alive = false;
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally stable — cy instance lives for component lifetime

  // ── React to degree slider changes ────────────────────────────────────────

  useEffect(() => {
    if (!cyRef.current) return;

    const cy = cyRef.current;

    if (cacheRef.current.has(degree)) {
      const state = cacheRef.current.get(degree)!;
      setTruncatedDegrees(new Set(state.truncatedAtDegree));
      applyStateToCytoscape(cy, state);
    } else {
      expandToDegreee(degree).then((state) => {
        if (!state || !cyRef.current) return;
        setTruncatedDegrees(new Set(state.truncatedAtDegree));
        applyStateToCytoscape(cyRef.current, state);
      });
    }
  }, [degree, expandToDegreee]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        borderRadius: "8px",
        padding: "12px 14px",
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      }}
    >
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
        <span
          style={{ color: "#888", fontSize: "11px", marginRight: "2px", letterSpacing: "0.08em" }}
        >
          DEPTH
        </span>
        {([1, 2, 3, 4] as const).map((d) => {
          const active = degree === d;
          const s = active ? DEGREE_BUTTON_STYLES.active : DEGREE_BUTTON_STYLES.inactive;
          return (
            <button
              key={d}
              onClick={() => setDegree(d)}
              style={{
                padding: "3px 13px",
                borderRadius: "4px",
                border: `1px solid ${s.borderColor}`,
                background: s.background,
                color: s.color,
                cursor: "pointer",
                fontWeight: s.fontWeight,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginLeft: truncatedDegrees.size > 0 ? "8px" : "auto",
          }}
        >
          <LegendDot color="#f59e0b" label="this entity" />
          <LegendDot color="#10b981" label="sameAs" dashed />
          <LegendDot color="#3b82f6" label="neighbor" />
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
        }}
      />

      <p
        style={{
          color: "#aaa",
          fontSize: "10px",
          margin: "7px 0 0",
          textAlign: "right",
          letterSpacing: "0.04em",
        }}
      >
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
