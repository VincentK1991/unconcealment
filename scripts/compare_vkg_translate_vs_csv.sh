#!/usr/bin/env bash
set -euo pipefail

# Compare live /query/vkg/translate SQL output against projected SQL captured in
# target/ontop-benchmark-output.csv.
#
# Usage:
#   scripts/compare_vkg_translate_vs_csv.sh [--csv PATH] [--base-url URL] [--dataset ID] [--limit N] [--exact]
#
# Notes:
# - Default comparison is whitespace-normalized SQL to avoid formatting-only diffs.
# - Use --exact for byte-for-byte SQL comparison.

CSV_PATH="target/ontop-benchmark-output.csv"
BASE_URL="http://localhost:8080"
DATASET="insurance"
LIMIT=""
EXACT="0"
TIMEOUT_SECONDS="30"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --csv)
      CSV_PATH="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --dataset)
      DATASET="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --exact)
      EXACT="1"
      shift
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,24p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$CSV_PATH" ]]; then
  echo "CSV not found: $CSV_PATH" >&2
  exit 2
fi

export CSV_PATH BASE_URL DATASET LIMIT EXACT TIMEOUT_SECONDS

python3 - <<'PY'
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

csv_path = os.environ["CSV_PATH"]
base_url = os.environ["BASE_URL"].rstrip("/")
dataset = os.environ["DATASET"]
limit_raw = os.environ.get("LIMIT", "").strip()
exact = os.environ.get("EXACT", "0") == "1"
timeout = float(os.environ.get("TIMEOUT_SECONDS", "30"))

limit = int(limit_raw) if limit_raw else None

required_columns = {
    "query",
    "sparql",
    "generated projected sql",
    "projected applied",
}

def normalize_sql(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()

def post_translate(sparql_text: str) -> dict:
    params = urllib.parse.urlencode(
        {"dataset": dataset, "projected": "true"}
    )
    url = f"{base_url}/query/vkg/translate?{params}"
    body = sparql_text.encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/sparql-query"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = resp.read().decode("utf-8")
    return json.loads(payload)

def check_health() -> None:
    url = f"{base_url}/health/live"
    try:
        with urllib.request.urlopen(url, timeout=min(timeout, 10.0)) as resp:
            _ = resp.read()
    except Exception as e:
        print(f"[warn] Could not confirm health endpoint {url}: {e}", file=sys.stderr)

check_health()

with open(csv_path, newline="") as f:
    reader = csv.DictReader(f)
    missing = required_columns - set(reader.fieldnames or [])
    if missing:
        print(f"[error] CSV missing required columns: {sorted(missing)}", file=sys.stderr)
        sys.exit(2)

    total = 0
    compared = 0
    skipped = 0
    endpoint_errors = 0
    mismatches = []

    for row in reader:
        if limit is not None and compared >= limit:
            break
        total += 1

        projected_applied = (row.get("projected applied") or "").strip()
        if projected_applied == "<SKIPPED>":
            skipped += 1
            continue

        sparql = row.get("sparql", "")
        expected_sql = row.get("generated projected sql", "")
        query_name = row.get("query", f"row-{total}")

        try:
            out = post_translate(sparql)
        except urllib.error.HTTPError as e:
            endpoint_errors += 1
            payload = e.read().decode("utf-8", errors="replace")
            mismatches.append({
                "row": total,
                "query": query_name,
                "reason": f"HTTP {e.code}",
                "details": payload[:4000],
            })
            continue
        except Exception as e:
            endpoint_errors += 1
            mismatches.append({
                "row": total,
                "query": query_name,
                "reason": "request_error",
                "details": str(e),
            })
            continue

        actual_sql = out.get("sql", "")
        compared += 1

        if exact:
            ok = actual_sql == expected_sql
        else:
            ok = normalize_sql(actual_sql) == normalize_sql(expected_sql)

        if not ok:
            mismatches.append({
                "row": total,
                "query": query_name,
                "reason": "sql_mismatch",
                "projectedRequested": out.get("projectedRequested"),
                "projectedApplied": out.get("projectedApplied"),
                "expected_sample": expected_sql[:500],
                "actual_sample": actual_sql[:500],
            })

mode = "exact" if exact else "normalized-whitespace"
print(f"compare_mode={mode}")
print(f"csv={csv_path}")
print(f"base_url={base_url}")
print(f"dataset={dataset}")
print(f"rows_seen={total}")
print(f"rows_compared={compared}")
print(f"rows_skipped={skipped}")
print(f"endpoint_errors={endpoint_errors}")
print(f"mismatches={len(mismatches)}")

if mismatches:
    print("\nFirst mismatches:")
    for m in mismatches[:10]:
        print(f"- row={m['row']} query={m['query']} reason={m['reason']}")
        if "projectedRequested" in m:
            print(f"  projectedRequested={m.get('projectedRequested')} projectedApplied={m.get('projectedApplied')}")
        if "expected_sample" in m:
            print(f"  expected_sql_sample={m['expected_sample']}")
            print(f"  actual_sql_sample={m['actual_sample']}")
        else:
            print(f"  details={m.get('details', '')}")
    sys.exit(1)

print("\nAll compared rows matched.")
PY
