# Census PDF Crawler

Local crawler to start from a seed page, traverse scoped child pages, and download PDFs.

## What It Does

- Starts at `https://www.census.gov/library/publications.html`
- Crawls child pages under:
  - `/library/publications/2019/`
  - `/library/publications/2020/`
- Crawls up to depth `3`
- Downloads up to `100` PDFs
- Allows PDF hosts `www.census.gov` and `www2.census.gov` by default
- Preserves original filenames (adds `_2`, `_3`, etc. if needed)
- Adds a request delay (default `1.0s`) for polite crawling
- Supports resume using `state.json`
- Supports `--dry-run` mode to list PDF URLs only

## Setup

```bash
cd side_projects/census_pdf_crawler
uv sync
```

## Run

```bash
uv run crawler.py
```

## Useful Flags

```bash
uv run crawler.py \
  --max-depth 3 \
  --max-pdfs 100 \
  --delay-seconds 1.0 \
  --output-dir downloads \
  --state-file state.json
```

Custom scope example (override defaults):

```bash
uv run crawler.py \
  --allowed-prefix /library/publications/2026/ \
  --allowed-pdf-domain www.census.gov \
  --allowed-pdf-domain www2.census.gov
```

Dry run (no files written):

```bash
uv run crawler.py --dry-run
```

Resume an interrupted crawl:

```bash
uv run crawler.py --resume
```

## Notes

- This crawler only follows `http/https` links.
- PDF discovery is based on URL ending with `.pdf` and validated during download via `content-type` when available.
