import { startTransition, useEffect, useState, type CSSProperties } from "react";
import type { CanonicalStatus, NormalizationPageData } from "../lib/normalization";

type PageItem = { kind: "page"; n: number } | { kind: "ellipsis"; key: string };

const iriTail = (iri: string) => iri.split(/[/#]/).pop() ?? iri;

const entityLink = (datasetId: string, iri: string) =>
  `/entity/${encodeURIComponent(datasetId)}/${encodeURIComponent(iriTail(iri))}`;

const canonicalStatusMeta = (status: CanonicalStatus): { label: string; tone: "green" | "amber" } => {
  if (status === "graph") return { label: "graph canonical", tone: "green" };
  if (status === "derived") return { label: "derived canonical", tone: "amber" };
  return { label: "marker conflict", tone: "amber" };
};

const chipStyles: Record<"blue" | "amber" | "gray" | "green", CSSProperties> = {
  blue: { background: "#dde1ff", color: "#0040e0" },
  amber: { background: "#98f0ff", color: "#004f58" },
  gray: { background: "#eceef0", color: "#434656" },
  green: { background: "#c8f5d8", color: "#166534" },
};

function Chip({
  label,
  href,
  tone,
}: {
  label: string;
  href?: string;
  tone: "blue" | "amber" | "gray" | "green";
}) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "0.2rem 0.65rem",
    borderRadius: "9999px",
    fontSize: "0.7rem",
    fontWeight: 700,
    fontFamily: "Inter, sans-serif",
    letterSpacing: "0.03em",
    textDecoration: "none",
    ...chipStyles[tone],
  };

  if (href) {
    return <a href={href} style={style}>{label}</a>;
  }
  return <span style={style}>{label}</span>;
}

function StatCard({ value, label }: { value: string | number; label: string }) {
  return (
    <div
      style={{
        padding: "0.95rem 1.05rem",
        borderRadius: "1rem",
        background: "#ffffff",
        boxShadow: "0px 4px 20px rgba(25,28,30,0.04), 0px 12px 40px rgba(18,74,240,0.06)",
        minWidth: "10rem",
      }}
    >
      <div style={{ fontFamily: "Manrope, sans-serif", fontSize: "1.3rem", fontWeight: 800, color: "#191c1e" }}>
        {value}
      </div>
      <div style={{ marginTop: "0.2rem", fontSize: "0.78rem", color: "#747688", fontFamily: "Inter, sans-serif" }}>
        {label}
      </div>
    </div>
  );
}

function buildPaginationItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 1) return [];
  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter((n) => n === 1 || n === totalPages || Math.abs(n - page) <= 2);

  const items: PageItem[] = [];
  for (let i = 0; i < pageNums.length; i++) {
    if (i > 0 && pageNums[i]! - pageNums[i - 1]! > 1) {
      items.push({ kind: "ellipsis", key: `ellipsis-${pageNums[i - 1]}-${pageNums[i]}` });
    }
    items.push({ kind: "page", n: pageNums[i]! });
  }
  return items;
}

function readPageFromUrl(): number {
  if (typeof window === "undefined") return 1;
  const raw = Number.parseInt(new URL(window.location.href).searchParams.get("page") ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export default function NormalizationExplorer({
  datasetId,
  initialPage,
}: {
  datasetId: string;
  initialPage: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState<NormalizationPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onPopState = () => {
      startTransition(() => setPage(readPageFromUrl()));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/normalization/${encodeURIComponent(datasetId)}?page=${page}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Normalization API failed: ${res.status}`);
        }
        return res.json() as Promise<NormalizationPageData>;
      })
      .then((payload) => {
        setData(payload);
        if (payload.page !== page) {
          const url = new URL(window.location.href);
          url.searchParams.set("page", String(payload.page));
          window.history.replaceState({}, "", url);
          startTransition(() => setPage(payload.page));
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("[normalization]", err);
        setError("Failed to load normalization data.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [datasetId, page]);

  const changePage = (nextPage: number) => {
    if (!data) return;
    const clamped = Math.max(1, Math.min(nextPage, data.totalPages));
    if (clamped === page) return;
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(clamped));
    window.history.pushState({}, "", url);
    startTransition(() => setPage(clamped));
  };

  const paginationItems = data ? buildPaginationItems(data.page, data.totalPages) : [];
  const hasData = Boolean(data);

  return (
    <div>
      {error && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.9rem 1rem",
            borderRadius: "1rem",
            background: "rgba(239, 68, 68, 0.08)",
            color: "#7f1d1d",
            fontSize: "0.88rem",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {error}
        </div>
      )}

      {!hasData && loading && (
        <div
          style={{
            padding: "1rem 1.1rem",
            borderRadius: "1rem",
            background: "#ffffff",
            boxShadow: "0px 4px 20px rgba(25,28,30,0.04), 0px 12px 40px rgba(18,74,240,0.06)",
            color: "#434656",
            fontFamily: "Inter, sans-serif",
          }}
        >
          Loading normalization clusters...
        </div>
      )}

      {hasData && data.totalClusters === 0 && !loading && (
        <div
          style={{
            padding: "1rem 1.1rem",
            borderRadius: "1rem",
            background: "#ffffff",
            boxShadow: "0px 4px 20px rgba(25,28,30,0.04), 0px 12px 40px rgba(18,74,240,0.06)",
            color: "#434656",
            fontFamily: "Inter, sans-serif",
          }}
        >
          No normalization links or canonical markers were found in this named graph.
        </div>
      )}

      {hasData && data.totalClusters > 0 && (
        <>
          <div style={{ display: "flex", gap: "0.875rem", flexWrap: "wrap", marginBottom: "1.75rem" }}>
            <StatCard value={data.totalClusters} label="clusters" />
            <StatCard value={data.totalEntities} label="entities" />
            <StatCard value={data.totalEdges} label="sameAs links" />
            <StatCard value={data.displayedCanonicalCount} label="displayed canonicals" />
            <StatCard value={data.nonCanonicalCount} label="non-canonical entities" />
            {data.methodCounts.map((method) => (
              <StatCard key={method.method} value={method.count} label={`${method.label} links`} />
            ))}
          </div>

          {(data.derivedCanonicalCount > 0 ||
            data.conflictCanonicalCount > 0 ||
            data.graphCanonicalCount !== data.totalClusters) && (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.9rem 1rem",
                borderRadius: "1rem",
                background: "rgba(0, 64, 224, 0.05)",
                color: "#434656",
                fontSize: "0.85rem",
                lineHeight: 1.55,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {data.derivedCanonicalCount > 0 && (
                <div style={{ marginBottom: "0.2rem" }}>
                  {data.derivedCanonicalCount} cluster{data.derivedCanonicalCount === 1 ? "" : "s"} had no explicit
                  {" "}canonical marker, so the page derived a canonical from incoming <code>owl:sameAs</code> link count.
                </div>
              )}
              {data.conflictCanonicalCount > 0 && (
                <div style={{ marginBottom: "0.2rem" }}>
                  {data.conflictCanonicalCount} cluster{data.conflictCanonicalCount === 1 ? "" : "s"} had multiple
                  {" "}canonical markers in the graph.
                </div>
              )}
              {data.graphCanonicalCount !== data.totalClusters && (
                <div>
                  Graph canonical markers: {data.graphCanonicalCount}. Displayed cluster canonicals: {data.totalClusters}.
                </div>
              )}
            </div>
          )}

          <p style={{ fontSize: "0.75rem", color: "#747688", marginBottom: "0.75rem", fontFamily: "Inter, sans-serif" }}>
            Page {data.page} of {data.totalPages} ({data.totalClusters.toLocaleString()} total clusters)
            {loading && <span style={{ marginLeft: "0.4rem" }}>Refreshing...</span>}
          </p>

          <div
            style={{
              overflowX: "auto",
              borderRadius: "1rem",
              boxShadow: "0px 4px 20px rgba(25,28,30,0.04), 0px 12px 40px rgba(18,74,240,0.06)",
              background: "#ffffff",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", background: "#ffffff" }}>
              <caption
                style={{
                  fontSize: "0.7rem",
                  color: "#747688",
                  marginBottom: "0.25rem",
                  textAlign: "left",
                  padding: "0.75rem 1.25rem 0",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                Cluster view computed from owl:sameAs links in the normalization graph
              </caption>
              <thead>
                <tr style={{ background: "rgba(242,244,246,0.6)" }}>
                  {["Canonical entity", "Non-canonical entities", "Cluster"].map((column) => (
                    <th
                      key={column}
                      style={{
                        padding: "0.875rem 1.25rem",
                        textAlign: "left",
                        fontFamily: "Inter, sans-serif",
                        fontSize: "0.6875rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: "#747688",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.clusters.map((cluster, index) => {
                  const canonicalMeta = canonicalStatusMeta(cluster.canonicalStatus);
                  return (
                    <tr
                      key={cluster.canonicalIri}
                      style={{
                        borderTop: index === 0 ? "none" : "1px solid rgba(196, 197, 217, 0.18)",
                      }}
                    >
                      <td style={{ padding: "0.875rem 1.25rem", verticalAlign: "middle", fontFamily: "Inter, sans-serif" }}>
                        <a
                          className="link-primary"
                          style={{ fontWeight: 600, textDecoration: "none" }}
                          href={entityLink(datasetId, cluster.canonicalIri)}
                        >
                          {cluster.canonicalLabel}
                        </a>
                        <div
                          style={{
                            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                            fontSize: "0.68rem",
                            color: "#c4c5d9",
                            marginTop: "0.125rem",
                          }}
                          title={cluster.canonicalIri}
                        >
                          {iriTail(cluster.canonicalIri)}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.45rem" }}>
                          <Chip label={canonicalMeta.label} tone={canonicalMeta.tone} />
                          {cluster.explicitCanonicalCount > 1 && (
                            <Chip label={`${cluster.explicitCanonicalCount} markers`} tone="amber" />
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "0.875rem 1.25rem", verticalAlign: "middle", fontFamily: "Inter, sans-serif" }}>
                        {cluster.nonCanonicals.length > 0 ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                            {cluster.nonCanonicals.map((entity) => (
                              <Chip
                                key={entity.iri}
                                label={entity.label}
                                href={entityLink(datasetId, entity.iri)}
                                tone="gray"
                              />
                            ))}
                          </div>
                        ) : (
                          <span style={{ fontSize: "0.82rem", color: "#747688" }}>No non-canonical members</span>
                        )}
                      </td>
                      <td style={{ padding: "0.875rem 1.25rem", verticalAlign: "middle", fontFamily: "Inter, sans-serif" }}>
                        <div style={{ fontWeight: 700, color: "#191c1e" }}>{cluster.memberCount} entities</div>
                        <div style={{ fontSize: "0.78rem", color: "#747688", marginTop: "0.15rem" }}>
                          {cluster.edgeCount} sameAs link{cluster.edgeCount === 1 ? "" : "s"}
                        </div>
                        <div style={{ fontSize: "0.78rem", color: "#747688", marginTop: "0.15rem" }}>
                          {cluster.memberCount - 1} non-canonical member{cluster.memberCount === 2 ? "" : "s"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {paginationItems.length > 0 && (
            <nav
              style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", marginTop: "1.25rem" }}
              aria-label="Normalization pagination"
            >
              <button
                type="button"
                onClick={() => changePage(data.page - 1)}
                disabled={data.page <= 1}
                style={{
                  border: "1px solid rgba(196, 197, 217, 0.45)",
                  background: data.page <= 1 ? "#f3f4f6" : "#ffffff",
                  color: data.page <= 1 ? "#a3a6b4" : "#434656",
                  borderRadius: "9999px",
                  padding: "0.45rem 0.8rem",
                  fontSize: "0.8rem",
                  fontFamily: "Inter, sans-serif",
                  cursor: data.page <= 1 ? "default" : "pointer",
                }}
              >
                &#8249; Prev
              </button>

              {paginationItems.map((item) =>
                item.kind === "ellipsis" ? (
                  <span
                    key={item.key}
                    style={{
                      borderRadius: "9999px",
                      padding: "0.45rem 0.8rem",
                      fontSize: "0.8rem",
                      color: "#747688",
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    &#8230;
                  </span>
                ) : (
                  <button
                    key={item.n}
                    type="button"
                    onClick={() => changePage(item.n)}
                    style={{
                      border: item.n === data.page ? "1px solid #0040e0" : "1px solid rgba(196, 197, 217, 0.45)",
                      background: item.n === data.page ? "#dde1ff" : "#ffffff",
                      color: item.n === data.page ? "#0040e0" : "#434656",
                      borderRadius: "9999px",
                      padding: "0.45rem 0.8rem",
                      fontSize: "0.8rem",
                      fontFamily: "Inter, sans-serif",
                      cursor: "pointer",
                    }}
                  >
                    {item.n}
                  </button>
                )
              )}

              <button
                type="button"
                onClick={() => changePage(data.page + 1)}
                disabled={data.page >= data.totalPages}
                style={{
                  border: "1px solid rgba(196, 197, 217, 0.45)",
                  background: data.page >= data.totalPages ? "#f3f4f6" : "#ffffff",
                  color: data.page >= data.totalPages ? "#a3a6b4" : "#434656",
                  borderRadius: "9999px",
                  padding: "0.45rem 0.8rem",
                  fontSize: "0.8rem",
                  fontFamily: "Inter, sans-serif",
                  cursor: data.page >= data.totalPages ? "default" : "pointer",
                }}
              >
                Next &#8250;
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
