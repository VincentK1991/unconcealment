import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SqlResults {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface Props {
  datasetId: string;
  schema: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SqlExplorer({ datasetId, schema }: Props) {
  const [sql, setSql] = useState(`SELECT *\nFROM ${schema}.policy\nLIMIT 10`);
  const [results, setResults] = useState<SqlResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);

  async function runQuery() {
    if (!sql.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`/api/sql/${encodeURIComponent(datasetId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const data = await res.json();
      const t1 = performance.now();
      setElapsed(Math.round(t1 - t0));
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setResults(data as SqlResults);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Editor */}
      <div style={{ marginBottom: "1rem" }}>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={8}
          spellCheck={false}
          style={{
            width: "100%",
            padding: "0.75rem 1rem",
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
            fontSize: "0.8125rem",
            lineHeight: "1.6",
            color: "#191c1e",
            background: "#f8f8fb",
            border: "1px solid rgba(196,197,217,0.6)",
            borderRadius: "0.5rem",
            resize: "vertical",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            marginTop: "0.5rem",
          }}
        >
          <button
            onClick={runQuery}
            disabled={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.375rem",
              padding: "0.5rem 1.125rem",
              background: loading ? "#c4c5d9" : "#0040e0",
              color: "#fff",
              border: "none",
              borderRadius: "0.5rem",
              fontFamily: "'Manrope', sans-serif",
              fontSize: "0.8125rem",
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "0.9rem", fontVariationSettings: "'FILL' 0, 'wght' 400, 'opsz' 20" }}
            >
              {loading ? "hourglass_empty" : "play_arrow"}
            </span>
            {loading ? "Running…" : "Run"}
          </button>
          <span style={{ fontSize: "0.75rem", color: "#747688" }}>
            Ctrl+Enter to run · SELECT only · max 500 rows
          </span>
          {elapsed !== null && !loading && (
            <span style={{ fontSize: "0.75rem", color: "#747688", marginLeft: "auto" }}>
              {elapsed} ms
            </span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "0.75rem 1rem",
            background: "#fff5f5",
            border: "1px solid #fca5a5",
            borderRadius: "0.5rem",
            color: "#b91c1c",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: "0.8125rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.625rem",
            }}
          >
            <span style={{ fontSize: "0.8125rem", color: "#747688" }}>
              {results.rows.length} row{results.rows.length !== 1 ? "s" : ""}
              {results.rows.length === 500 ? " (limit reached)" : ""}
            </span>
          </div>
          <div style={{ overflowX: "auto", borderRadius: "0.5rem", border: "1px solid rgba(196,197,217,0.5)" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.8125rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f8" }}>
                  {results.columns.map((col) => (
                    <th
                      key={col}
                      style={{
                        padding: "0.5rem 0.875rem",
                        textAlign: "left",
                        fontFamily: "'Manrope', sans-serif",
                        fontWeight: 700,
                        color: "#191c1e",
                        borderBottom: "1px solid rgba(196,197,217,0.5)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.rows.map((row, i) => (
                  <tr
                    key={i}
                    style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}
                  >
                    {results.columns.map((col) => {
                      const val = row[col];
                      const display = val === null || val === undefined ? "" : String(val);
                      return (
                        <td
                          key={col}
                          style={{
                            padding: "0.4375rem 0.875rem",
                            color: val === null || val === undefined ? "#c4c5d9" : "#191c1e",
                            fontStyle: val === null || val === undefined ? "italic" : "normal",
                            borderBottom: "1px solid rgba(196,197,217,0.25)",
                            maxWidth: "30rem",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={display}
                        >
                          {val === null || val === undefined ? "null" : display}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
