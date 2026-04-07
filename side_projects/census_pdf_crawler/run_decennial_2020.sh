#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/data/economic-census"

mkdir -p "$OUTPUT_DIR"
cd "$SCRIPT_DIR"

ARGS=(
  --seed-url "https://www.census.gov/topics/population/publications.html"
  --allowed-prefix "/topics/population/publications/"
  --allowed-prefix "/library/publications"
  --min-year 2020
  --max-depth 5
  --max-pdfs 150
  --output-dir "$OUTPUT_DIR"
  --allowed-pdf-domain "www.census.gov"
  --allowed-pdf-domain "www2.census.gov"
  --exclude-filename-prefix "figure"
  --exclude-filename-prefix "table"
  --verbose
)

uv run crawler.py "${ARGS[@]}" "$@"
