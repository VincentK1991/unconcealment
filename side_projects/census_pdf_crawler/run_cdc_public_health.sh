#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/data/public-health"
STATE_FILE="$SCRIPT_DIR/state_cdc_public_health.json"

mkdir -p "$OUTPUT_DIR"
cd "$SCRIPT_DIR"

ARGS=(
  --seed-url "https://www.cdc.gov/nchs/pressroom/calendar/2020_schedule.htm"
  --allowed-prefix "/nchs/pressroom/calendar/"
  --allowed-prefix "/nchs/pressroom/"
  --allowed-prefix "/nchs/"
  --max-depth 4
  --max-pdfs 50
  --delay-seconds 1.0
  --output-dir "$OUTPUT_DIR"
  --state-file "$STATE_FILE"
  --allowed-pdf-domain "www.cdc.gov"
  --allowed-pdf-domain "cdc.gov"
  --allowed-pdf-domain "stacks.cdc.gov"
  --verbose
)

uv run crawler.py "${ARGS[@]}" "$@"
