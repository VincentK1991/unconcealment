#!/usr/bin/env python3
"""Crawl Census publication pages and download PDFs."""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup


DEFAULT_SEED = "https://www.census.gov/programs-surveys/decennial-census/decade/2020/2020-census-results.html"
DEFAULT_ALLOWED_PREFIXES = [
    #"/library/publications/2019/",
    #"/library/publications/2020/",
]
DEFAULT_OUTPUT_DIR = Path("downloads")
DEFAULT_STATE_FILE = Path("state.json")


@dataclass
class CrawlState:
    queue: deque[tuple[str, int]]
    visited_pages: set[str]
    seen_pdf_urls: set[str]
    downloaded_pdf_urls: set[str]
    downloaded_count: int


class RateLimiter:
    def __init__(self, delay_seconds: float) -> None:
        self.delay_seconds = delay_seconds
        self._last_time = 0.0

    def wait(self) -> None:
        if self.delay_seconds <= 0:
            return
        elapsed = time.time() - self._last_time
        remaining = self.delay_seconds - elapsed
        if remaining > 0:
            time.sleep(remaining)
        self._last_time = time.time()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Crawl child pages and download PDFs from a scoped domain/path."
    )
    parser.add_argument("--seed-url", default=DEFAULT_SEED, help="Starting page URL.")
    parser.add_argument(
        "--allowed-prefix",
        action="append",
        dest="allowed_prefixes",
        help=(
            "Allowed path prefix for crawling child pages. "
            "Can be repeated. Defaults to Census 2019 and 2020 publication paths."
        ),
    )
    parser.add_argument(
        "--allowed-pdf-domain",
        action="append",
        dest="allowed_pdf_domains",
        help=(
            "Allowed host for PDF downloads. Can be repeated. "
            "Defaults to seed host plus www2.<seed-host-root>."
        ),
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=3,
        help="Max crawl depth from seed page (default: 3).",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=500,
        help="Max pages to crawl (default: 500).",
    )
    parser.add_argument(
        "--max-pdfs",
        type=int,
        default=100,
        help="Max PDFs to download (default: 100).",
    )
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=1.0,
        help="Delay between requests in seconds (default: 1.0).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=30.0,
        help="HTTP timeout in seconds (default: 30).",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Retries per request on network errors (default: 2).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory to write PDFs (default: {DEFAULT_OUTPUT_DIR}).",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=DEFAULT_STATE_FILE,
        help=f"State file for resume support (default: {DEFAULT_STATE_FILE}).",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from state file if present.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Crawl and report PDF URLs without downloading files.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print more crawl details.",
    )
    parser.add_argument(
        "--min-year",
        type=int,
        default=None,
        help=(
            "If set, only keep URLs containing a year >= this value. "
            "URLs with no year are still allowed for traversal."
        ),
    )
    parser.add_argument(
        "--exclude-filename-prefix",
        action="append",
        dest="exclude_filename_prefixes",
        default=[],
        help=(
            "Skip PDF downloads when filename starts with this prefix. "
            "Can be repeated (case-insensitive)."
        ),
    )
    return parser.parse_args()


def canonicalize_url(url: str) -> str:
    clean, _ = urldefrag(url)
    parsed = urlparse(clean)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return parsed._replace(scheme=scheme, netloc=netloc, path=path).geturl()


def is_same_domain(url: str, seed_url: str) -> bool:
    return urlparse(url).netloc.lower() == urlparse(seed_url).netloc.lower()


def build_allowed_pdf_domains(
    seed_url: str, user_domains: list[str] | None
) -> set[str]:
    if user_domains:
        return {d.lower() for d in user_domains}
    seed_host = urlparse(seed_url).netloc.lower()
    parts = seed_host.split(".")
    domains = {seed_host}
    if len(parts) >= 2:
        root = ".".join(parts[-2:])
        domains.add(f"www2.{root}")
    return domains


def is_allowed_pdf_domain(url: str, allowed_pdf_domains: set[str]) -> bool:
    return urlparse(url).netloc.lower() in allowed_pdf_domains


def should_crawl_page(url: str, seed_url: str, allowed_prefixes: Iterable[str]) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    if not is_same_domain(url, seed_url):
        return False
    if canonicalize_url(url) == canonicalize_url(seed_url):
        return True
    return any(parsed.path.startswith(prefix) for prefix in allowed_prefixes)


def is_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    return parsed.path.lower().endswith(".pdf")


def extract_year_from_url(url: str) -> int | None:
    parts = urlparse(url).path.split("/")
    for part in parts:
        if re.fullmatch(r"(19|20)\d{2}", part):
            return int(part)
    return None


def passes_min_year(url: str, min_year: int | None) -> bool:
    if min_year is None:
        return True
    year = extract_year_from_url(url)
    if year is None:
        return True
    return year >= min_year


def extract_links(html: str, page_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    links: list[str] = []
    seen: set[str] = set()
    for tag in soup.find_all("a", href=True):
        link = canonicalize_url(urljoin(page_url, tag["href"]))
        if link not in seen:
            seen.add(link)
            links.append(link)

    # Fallback for URLs embedded in scripts/data attributes where no <a href> exists.
    for match in re.finditer(r"""["']((?:https?://|/)[^"'<> ]+)["']""", html):
        raw = match.group(1)
        lower = raw.lower()
        if (
            ".pdf" not in lower
            and ".html" not in lower
            and ".htm" not in lower
            and "/library/publications" not in lower
        ):
            continue
        link = canonicalize_url(urljoin(page_url, raw))
        if link not in seen:
            seen.add(link)
            links.append(link)
    return links


def safe_filename(url: str, output_dir: Path) -> Path:
    parsed = urlparse(url)
    name = Path(parsed.path).name or "download.pdf"
    target = output_dir / name
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix or ".pdf"
    counter = 2
    while True:
        candidate = output_dir / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def should_skip_pdf_by_filename(url: str, prefixes: list[str]) -> bool:
    if not prefixes:
        return False
    filename = Path(urlparse(url).path).name.lower()
    normalized = [p.lower() for p in prefixes if p]
    return any(filename.startswith(prefix) for prefix in normalized)


def save_state(state_file: Path, state: CrawlState) -> None:
    payload = {
        "queue": list(state.queue),
        "visited_pages": sorted(state.visited_pages),
        "seen_pdf_urls": sorted(state.seen_pdf_urls),
        "downloaded_pdf_urls": sorted(state.downloaded_pdf_urls),
        "downloaded_count": state.downloaded_count,
    }
    state_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def load_state(state_file: Path) -> CrawlState:
    payload = json.loads(state_file.read_text(encoding="utf-8"))
    return CrawlState(
        queue=deque((str(url), int(depth)) for url, depth in payload["queue"]),
        visited_pages=set(payload["visited_pages"]),
        seen_pdf_urls=set(payload["seen_pdf_urls"]),
        downloaded_pdf_urls=set(payload["downloaded_pdf_urls"]),
        downloaded_count=int(payload["downloaded_count"]),
    )


def request_with_retries(
    client: httpx.Client,
    method: str,
    url: str,
    retries: int,
    limiter: RateLimiter,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            limiter.wait()
            response = client.request(method, url)
            response.raise_for_status()
            return response
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            last_error = exc
            if attempt == retries:
                raise
            sleep_time = min(4.0, 0.5 * (2**attempt))
            time.sleep(sleep_time)
    assert last_error is not None
    raise RuntimeError(f"Failed request for {url}: {last_error}")


def crawl(args: argparse.Namespace) -> None:
    allowed_prefixes = args.allowed_prefixes or DEFAULT_ALLOWED_PREFIXES
    seed_url = canonicalize_url(args.seed_url)
    allowed_pdf_domains = build_allowed_pdf_domains(seed_url, args.allowed_pdf_domains)
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    state_file: Path = args.state_file

    if args.resume and state_file.exists():
        state = load_state(state_file)
    else:
        state = CrawlState(
            queue=deque([(seed_url, 0)]),
            visited_pages=set(),
            seen_pdf_urls=set(),
            downloaded_pdf_urls=set(),
            downloaded_count=0,
        )

    limiter = RateLimiter(args.delay_seconds)
    headers = {"User-Agent": "CensusPDFCrawler/1.0 (+public-data-crawler)"}
    with httpx.Client(
        follow_redirects=True,
        timeout=args.timeout_seconds,
        headers=headers,
    ) as client:
        pages_crawled = 0
        while state.queue and pages_crawled < args.max_pages:
            if state.downloaded_count >= args.max_pdfs:
                break

            page_url, depth = state.queue.popleft()
            page_url = canonicalize_url(page_url)
            if page_url in state.visited_pages:
                continue
            if depth > args.max_depth:
                continue
            if not should_crawl_page(page_url, seed_url, allowed_prefixes):
                continue
            if not passes_min_year(page_url, args.min_year):
                continue

            try:
                response = request_with_retries(
                    client=client,
                    method="GET",
                    url=page_url,
                    retries=args.retries,
                    limiter=limiter,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] page failed: {page_url} ({exc})")
                continue

            content_type = response.headers.get("content-type", "").lower()
            if "text/html" not in content_type:
                if args.verbose:
                    print(f"[skip] non-html page: {page_url} ({content_type})")
                state.visited_pages.add(page_url)
                continue

            pages_crawled += 1
            state.visited_pages.add(page_url)
            if args.verbose:
                print(f"[crawl] depth={depth} {page_url}")

            links = extract_links(response.text, page_url)
            for link in links:
                if is_pdf_url(link):
                    if not is_allowed_pdf_domain(link, allowed_pdf_domains):
                        continue
                    if not passes_min_year(link, args.min_year):
                        continue
                    if should_skip_pdf_by_filename(link, args.exclude_filename_prefixes):
                        if args.verbose:
                            print(f"[skip] excluded filename: {link}")
                        continue
                    if link in state.seen_pdf_urls:
                        continue
                    state.seen_pdf_urls.add(link)

                    if args.dry_run:
                        print(f"[pdf] {link}")
                    else:
                        if state.downloaded_count >= args.max_pdfs:
                            break
                        target_path = safe_filename(link, output_dir)
                        try:
                            pdf_response = request_with_retries(
                                client=client,
                                method="GET",
                                url=link,
                                retries=args.retries,
                                limiter=limiter,
                            )
                            pdf_type = pdf_response.headers.get("content-type", "").lower()
                            if "pdf" not in pdf_type and not link.lower().endswith(".pdf"):
                                print(f"[skip] not-pdf content: {link} ({pdf_type})")
                                continue
                            target_path.write_bytes(pdf_response.content)
                            state.downloaded_pdf_urls.add(link)
                            state.downloaded_count += 1
                            print(f"[saved] {target_path} <- {link}")
                        except Exception as exc:  # noqa: BLE001
                            print(f"[warn] pdf failed: {link} ({exc})")
                elif depth < args.max_depth and should_crawl_page(
                    link, seed_url, allowed_prefixes
                ):
                    if not passes_min_year(link, args.min_year):
                        continue
                    if link not in state.visited_pages:
                        state.queue.append((link, depth + 1))

            save_state(state_file, state)

    save_state(state_file, state)
    print(
        f"[done] pages_crawled={len(state.visited_pages)} "
        f"pdf_links_seen={len(state.seen_pdf_urls)} "
        f"pdf_downloaded={state.downloaded_count}"
    )
    print(f"[state] {state_file}")
    if not args.dry_run:
        print(f"[output] {output_dir.resolve()}")


def main() -> None:
    args = parse_args()
    crawl(args)


if __name__ == "__main__":
    main()
