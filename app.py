#!/usr/bin/env python3
"""Marginalia — a local English reader with dictionary lookup and a vocabulary notebook."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    DATA = Path.home() / "Library" / "Application Support" / "Marginalia"
else:
    ROOT = Path(__file__).resolve().parent
    DATA = ROOT / "data"

STATIC = ROOT / "static"
DB_PATH = DATA / "reader.db"
HELPER = ROOT / "bin" / "dictlookup"
HELPER_SRC = ROOT / "bin" / "dictlookup.swift"
PDF_HELPER = ROOT / "bin" / "pdftext"
PDF_HELPER_SRC = ROOT / "bin" / "pdftext.swift"
OXFORD_ID = "com.apple.dictionary.zh_CN-en.OCD"

DICT_DIR = DATA / "dictionaries"
DICT_SEARCH_DIRS = [DICT_DIR, ROOT / "dictionaries"]

DAY = 86_400_000
MINUTE = 60_000
MAX_UPLOAD = 120 * 1024 * 1024

DATA.mkdir(parents=True, exist_ok=True)
DICT_DIR.mkdir(parents=True, exist_ok=True)
for _helper in (HELPER, PDF_HELPER):
    try:
        if _helper.exists():
            os.chmod(_helper, 0o755)
    except OSError:
        pass


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- db


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                format TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_opened TEXT,
                progress REAL NOT NULL DEFAULT 0,
                report TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS notebook (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT NOT NULL UNIQUE COLLATE NOCASE,
                lemma TEXT,
                phonetic TEXT,
                english TEXT NOT NULL DEFAULT '[]',
                chinese TEXT NOT NULL DEFAULT '',
                context TEXT NOT NULL DEFAULT '',
                document_id INTEGER,
                created_at TEXT NOT NULL,
                srs TEXT NOT NULL,
                stats TEXT NOT NULL,
                known INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS lookup_cache (
                key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                paragraph_index INTEGER NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                quote TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_highlights_document
                ON highlights(document_id, paragraph_index);
            CREATE TABLE IF NOT EXISTS local_dict_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                language TEXT NOT NULL,
                entries INTEGER NOT NULL DEFAULT 0,
                mtime REAL NOT NULL DEFAULT 0,
                imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_dict_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                headword TEXT NOT NULL,
                normalized TEXT NOT NULL,
                text TEXT NOT NULL,
                data TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_dict_norm
                ON local_dict_entries(normalized);
            """
        )
        columns = [row[1] for row in conn.execute("PRAGMA table_info(local_dict_entries)").fetchall()]
        if "data" not in columns:
            conn.execute("ALTER TABLE local_dict_entries ADD COLUMN data TEXT")
        doc_columns = [row[1] for row in conn.execute("PRAGMA table_info(documents)").fetchall()]
        if "report" not in doc_columns:
            conn.execute("ALTER TABLE documents ADD COLUMN report TEXT NOT NULL DEFAULT '{}'")


def get_setting(key: str, default: str = "") -> str:
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


# --------------------------------------------------------------------- srs


def blank_srs() -> dict:
    return {
        "state": "new",
        "step": 0,
        "ease": 2.5,
        "interval": 0,
        "due": now_ms(),
        "reps": 0,
        "lapses": 0,
    }


def blank_stats() -> dict:
    return {"seen": 0, "correct": 0}


def graduate(srs: dict, now: int, days: int) -> None:
    srs["state"] = "review"
    srs["step"] = 0
    srs["interval"] = days
    srs["due"] = now + days * DAY
    srs["ease"] = max(2.5, float(srs.get("ease") or 2.5))


def schedule(srs_in: dict | None, grade: int, now: int | None = None) -> dict:
    now = now or now_ms()
    srs = dict(srs_in or blank_srs())
    for key, value in blank_srs().items():
        srs.setdefault(key, value)
    srs["reps"] = int(srs.get("reps") or 0) + 1

    if srs["state"] == "new":
        srs["state"] = "learning"
        srs["step"] = 0
        srs["ease"] = 2.5
        srs["interval"] = 0

    if srs["state"] == "learning":
        if grade == 1:
            srs["step"] = 0
            srs["due"] = now + MINUTE
        elif grade == 2:
            srs["due"] = now + (6 if srs["step"] == 0 else 10) * MINUTE
        elif grade == 3:
            if srs["step"] >= 1:
                graduate(srs, now, 1)
            else:
                srs["step"] = 1
                srs["due"] = now + 10 * MINUTE
        else:
            graduate(srs, now, 4)
        return srs

    if srs["state"] == "relearning":
        if grade == 1:
            srs["due"] = now + 10 * MINUTE
        elif grade == 2:
            srs["due"] = now + 15 * MINUTE
        elif grade == 3:
            graduate(srs, now, 1)
        else:
            graduate(srs, now, 3)
        return srs

    if grade == 1:
        srs["lapses"] = int(srs.get("lapses") or 0) + 1
        srs["ease"] = max(1.3, float(srs["ease"]) - 0.2)
        srs["interval"] = max(1, round(int(srs["interval"]) * 0.5))
        srs["state"] = "relearning"
        srs["step"] = 0
        srs["due"] = now + 10 * MINUTE
        return srs

    interval = max(1, int(srs.get("interval") or 1))
    ease = float(srs.get("ease") or 2.5)
    if grade == 2:
        srs["ease"] = max(1.3, ease - 0.15)
        srs["interval"] = max(interval + 1, round(interval * 1.2))
    elif grade == 3:
        srs["interval"] = max(1, round(interval * ease))
    else:
        srs["ease"] = min(3.2, ease + 0.15)
        srs["interval"] = max(interval + 1, round(interval * ease * 1.3))
    srs["interval"] = min(int(srs["interval"]), 3650)
    srs["state"] = "review"
    srs["step"] = 0
    srs["due"] = now + int(srs["interval"]) * DAY
    return srs


def format_delay(ms: int) -> str:
    if ms <= 0:
        return "now"
    if ms < MINUTE:
        return "<1m"
    if ms < 60 * MINUTE:
        return f"{round(ms / MINUTE)}m"
    if ms < DAY:
        return f"{round(ms / (60 * MINUTE))}h"
    if ms < 30 * DAY:
        return f"{round(ms / DAY)}d"
    if ms < 365 * DAY:
        return f"{round(ms / (30 * DAY))}mo"
    return f"{round(ms / (365 * DAY), 1)}y"


# ------------------------------------------------------------------ document parsing


def clean_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?<=\w)-\n(?=[a-z])", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


LIGATURE_MAP = str.maketrans(
    {
        "\ufb00": "ff",
        "\ufb01": "fi",
        "\ufb02": "fl",
        "\ufb03": "ffi",
        "\ufb04": "ffl",
        "\ufb05": "st",
        "\ufb06": "st",
    }
)
LIST_LINE_RE = re.compile(r"^\s*(?:[-*•–—]|\d{1,3}[.)])\s+\S")
SENTENCE_END_RE = re.compile(r"[.!?…。！？][\"'”’)\]]*$")
HYPHEN_KEEP = {
    "to", "the", "a", "an", "and", "or", "of", "in", "on", "at", "by", "for",
    "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "his", "her", "their", "our",
    "your", "my", "not", "but", "so", "if", "when", "while", "because", "well",
    "known", "self", "non", "pre", "post", "anti", "co", "re", "multi", "semi",
    "sub", "super", "over", "under", "out", "up", "down", "long", "short",
    "high", "low", "first", "second", "third", "one", "two", "three", "twenty",
}


def _is_cjk_char(char: str) -> bool:
    return bool(char) and bool(re.match(r"[\u3400-\u9fff]", char))


def _join_polished_lines(lines: list[str], report: dict) -> str:
    out: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if not out:
            out.append(line)
            continue
        prev = out[-1]
        if prev.endswith("-") and line[:1].islower():
            next_word = re.match(r"[A-Za-z]+", line)
            if next_word and next_word.group(0).lower() in HYPHEN_KEEP:
                out[-1] = prev + line
            else:
                out[-1] = prev[:-1] + line
                report["hyphen_joins"] += 1
        elif prev.endswith(("-", "—")):
            out[-1] = prev + line
        else:
            separator = "" if (_is_cjk_char(prev[-1:]) and _is_cjk_char(line[:1])) else " "
            out[-1] = prev + separator + line
            report["joined_lines"] += 1
    return " ".join(out) if len(out) == 1 else " ".join(out)


def _join_block(lines: list[str], report: dict) -> tuple[str, str]:
    if len(lines) >= 2 and sum(1 for line in lines if LIST_LINE_RE.match(line)) >= max(2, len(lines) // 2):
        items: list[str] = []
        for line in lines:
            line = line.strip()
            if LIST_LINE_RE.match(line) or not items:
                items.append(line)
            else:
                items[-1] += " " + line
                report["joined_lines"] += 1
        return "\n\n".join(items), "list"
    return _join_polished_lines(lines, report), "body"


def _remove_page_furniture(pages: list[str], report: dict) -> list[str]:
    if len(pages) < 2:
        return pages
    first_lines: dict[str, int] = {}
    last_lines: dict[str, int] = {}
    for page in pages:
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        if lines:
            first_lines[lines[0].lower()] = first_lines.get(lines[0].lower(), 0) + 1
            last_lines[lines[-1].lower()] = last_lines.get(lines[-1].lower(), 0) + 1
    threshold = max(3, round(len(pages) * 0.3))
    repeated = {
        line for line, count in {**first_lines, **last_lines}.items()
        if count >= threshold
    }
    cleaned = []
    for page in pages:
        lines = page.splitlines()
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        if lines:
            first = lines[0].strip() if lines else ""
            last = lines[-1].strip() if lines else ""
            if first and _page_number_line(first):
                lines.pop(0)
                report["removed_page_numbers"] += 1
            if lines and _page_number_line(lines[-1].strip()):
                lines.pop()
                report["removed_page_numbers"] += 1
            first = lines[0].strip() if lines else ""
            if lines and first.lower() in repeated and len(first) < 120:
                lines.pop(0)
                report["removed_headers"] += 1
            if lines and lines[-1].strip().lower() in repeated and len(lines[-1].strip()) < 120:
                lines.pop()
                report["removed_headers"] += 1
        cleaned.append("\n".join(lines).strip())
    return cleaned


def polish_text(text: str, fmt: str = "") -> tuple[str, dict]:
    """Normalize text and repair common extraction/layout artifacts.

    The repair is deliberately conservative: it joins hard-wrapped lines,
    removes running heads and page numbers at page boundaries, and merges only
    paragraphs that clearly continue a sentence. It never invents text.
    """
    report = {
        "checked": True,
        "joined_lines": 0,
        "hyphen_joins": 0,
        "merged_paragraphs": 0,
        "removed_headers": 0,
        "removed_page_numbers": 0,
        "normalized_characters": 0,
        "paragraphs": 0,
        "characters": 0,
        "warnings": [],
    }
    if not text:
        return "", report

    original = text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.translate(LIGATURE_MAP)
    text = text.replace("\u00ad", "").replace("\u200b", "").replace("\ufeff", "")
    text = text.replace("\u00a0", " ").replace("\u2028", "\n").replace("\u2029", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    report["normalized_characters"] = sum(1 for a, b in zip(original, text) if a != b)

    pages = re.split(r"<<<PAGE>>>", text)
    pages = [page.strip() for page in pages]
    pages = _remove_page_furniture(pages, report)

    processed_pages = []
    for page in pages:
        blocks = [block for block in re.split(r"\n{2,}", page) if block.strip()]
        processed: list[tuple[str, str]] = []
        for block in blocks:
            lines = [line for line in block.splitlines() if line.strip()]
            if not lines:
                continue
            joined, kind = _join_block(lines, report)
            if not joined:
                continue
            if processed and kind == "body" and processed[-1][1] == "body":
                previous = processed[-1][0]
                next_text = joined.lstrip()
                continues = (
                    not SENTENCE_END_RE.search(previous.rstrip())
                    and bool(next_text)
                    and (next_text[0].islower() or previous.rstrip().endswith((",", ";", ":", "-", "—")))
                )
                if continues:
                    separator = "" if (_is_cjk_char(previous[-1:]) and _is_cjk_char(next_text[:1])) else " "
                    processed[-1] = (previous.rstrip() + separator + next_text, "body")
                    report["merged_paragraphs"] += 1
                    continue
            processed.append((joined, kind))
        processed_pages.append("\n\n".join(part for part, _ in processed))

    text = "\n\n<<<PAGE>>>\n\n".join(part for part in processed_pages if part.strip())
    text = re.sub(r"[ \t]+([,.;:!?])", r"\1", text)
    text = re.sub(r"(?<=[a-z])([.!?])(?=[A-Z])", r"\1 ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip() and p.strip() != "<<<PAGE>>>"]
    report["paragraphs"] = len(paragraphs)
    report["characters"] = len(text)
    long_unterminated = [
        p for p in paragraphs
        if len(p) > 80 and not SENTENCE_END_RE.search(p) and not p.isupper() and not LIST_LINE_RE.match(p)
    ]
    if long_unterminated:
        report["warnings"].append(
            f"{len(long_unterminated)} paragraph(s) end without clear punctuation. "
            "They may be headings, captions, or broken sentences; glance at them if the text looks choppy."
        )
    if text.count('"') % 2:
        report["warnings"].append("The text contains an odd number of straight quotation marks.")
    if report["joined_lines"] or report["hyphen_joins"] or report["merged_paragraphs"] or report["removed_headers"] or report["removed_page_numbers"]:
        report["summary"] = (
            f"Joined {report['joined_lines']} wrapped lines, repaired {report['hyphen_joins']} hyphenated words, "
            f"merged {report['merged_paragraphs']} paragraphs, removed {report['removed_headers']} headers and "
            f"{report['removed_page_numbers']} page numbers."
        )
    else:
        report["summary"] = "No layout repairs were needed."
    return text, report


PDF_META_RE = re.compile(
    r"^(arxiv:\S+|provided proper attribution|reproduce the tables|scholarly works\.?$|"
    r"downloaded from|©|copyright|all rights reserved|this article is protected|"
    r"for personal use only|https?://|doi:|DOI:|ISSN|ISBN|preprint|accepted manuscript|"
    r"first published|this is an open access article)",
    re.IGNORECASE,
)
PAGE_NO_RE = re.compile(r"^(page\s*)?[\divxlcdm]{1,6}(\s*(/|of)\s*\d{1,4})?$", re.IGNORECASE)


def _pdf_title(path: Path) -> str:
    try:
        from pypdf import PdfReader

        meta = PdfReader(str(path)).metadata or {}
        return str(meta.get("/Title") or "").strip()
    except Exception:
        return ""


def _page_number_line(text: str) -> bool:
    compact = text.strip().replace(" ", "")
    if not compact or len(compact) > 12:
        return False
    if compact.isdigit() or compact.lower() in {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"}:
        return True
    return bool(PAGE_NO_RE.match(text.strip()))


def _clean_pdf_lines(lines: list[dict]) -> str:
    """Remove running heads, page numbers, metadata, and small bottom-of-page notes."""
    if not lines:
        return ""

    from collections import defaultdict
    from statistics import median

    by_page: dict[int, list[dict]] = defaultdict(list)
    for line in lines:
        text = re.sub(r"\s+", " ", str(line.get("text") or "")).strip()
        if text:
            item = dict(line)
            item["text"] = text
            by_page[int(line.get("page") or 1)].append(item)
    if not by_page:
        return ""

    page_count = len(by_page)
    sizes: list[float] = []
    for line in lines:
        text = str(line.get("text") or "")
        if len(text) >= 18 and not PDF_META_RE.match(text.strip()):
            sizes.extend([float(line.get("size") or 0)] * min(len(text), 90))
    body = median(sizes) if sizes else median([float(x.get("size") or 0) for x in lines])

    def repeat_key(text: str) -> str:
        return re.sub(r"\d+", "#", text.lower()).strip()

    occurrences: dict[str, set[int]] = defaultdict(set)
    for page, page_lines in by_page.items():
        for line in page_lines:
            occurrences[repeat_key(line["text"])].add(page)
    repeated = {
        text for text, pages in occurrences.items()
        if len(pages) >= max(3, round(page_count * 0.3))
    }

    cleaned: dict[int, list[dict]] = {}
    for page, page_lines in by_page.items():
        kept: list[dict] = []
        for line in page_lines:
            text = line["text"]
            page_h = float(line.get("pageHeight") or 792)
            y = float(line.get("y") or 0)
            size = float(line.get("size") or 0)
            at_top = y >= page_h * 0.86
            at_bottom = y <= page_h * 0.30

            if PDF_META_RE.match(text):
                continue
            if (at_top or at_bottom) and _page_number_line(text):
                continue
            if repeated and repeat_key(text) in repeated and (at_top or at_bottom) and len(text) < 120:
                continue
            if at_bottom and size <= body * 0.90:
                continue
            if size < body * 0.60:
                continue
            kept.append(line)
        if kept:
            cleaned[page] = kept

    chunks: list[str] = []
    for page in sorted(cleaned):
        page_lines = cleaned[page]
        buf = ""
        prev = None
        for line in page_lines:
            text = line["text"]
            if prev is None:
                buf = text
            else:
                gap = float(prev.get("y") or 0) - float(line.get("y") or 0)
                prev_h = float(prev.get("height") or 0) or float(prev.get("size") or 10)
                new_para = gap > prev_h * 1.9
                if prev["text"].endswith((".", "!", "?", ":", ";")) and gap > prev_h * 1.35:
                    new_para = True
                if new_para:
                    buf += "\n\n" + text
                elif buf.endswith("-") and text[:1].islower():
                    # Keep the hyphen: it may be a real compound (English-to-German).
                    # Removing a line-break hyphen would corrupt those words.
                    buf += text
                else:
                    buf += " " + text
            prev = line
        if buf.strip():
            chunks.append(buf.strip())

    return "\n\n<<<PAGE>>>\n\n".join(chunks)


def extract_pdf(path: Path) -> tuple[str, str]:
    title = _pdf_title(path)

    if PDF_HELPER.exists() and os.access(PDF_HELPER, os.X_OK):
        try:
            result = subprocess.run(
                [str(PDF_HELPER), str(path)],
                capture_output=True,
                text=True,
                timeout=180,
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = json.loads(result.stdout)
                text = _clean_pdf_lines(lines)
                if len(text) >= 40:
                    return text, title
        except Exception:
            pass

    # Fallback for machines where PDFKit extraction is unavailable.
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages: list[str] = []
    for page in reader.pages:
        try:
            page_text = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            page_text = page.extract_text() or ""
        except Exception:
            page_text = ""
        page_text = page_text.replace("\x00", "")
        page_text = re.sub(r"[ \t]+\n", "\n", page_text)
        page_text = re.sub(r"\n{3,}", "\n\n", page_text).strip()
        if page_text:
            pages.append(page_text)

    if not pages or len("".join(pages)) < 40:
        raise ValueError("This PDF has no selectable text. It may be a scan; OCR is not supported yet.")

    return "\n\n<<<PAGE>>>\n\n".join(pages), title


def extract_docx(path: Path) -> tuple[str, str]:
    import zipfile
    import xml.etree.ElementTree as ET

    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    DC = "{http://purl.org/dc/elements/1.1/}"
    with zipfile.ZipFile(path) as archive:
        try:
            root = ET.fromstring(archive.read("word/document.xml"))
        except KeyError as exc:
            raise ValueError("This is not a valid .docx file.") from exc
        paragraphs: list[str] = []
        for paragraph in root.iter(f"{W}p"):
            pieces = [node.text or "" for node in paragraph.iter(f"{W}t")]
            text = "".join(pieces).strip()
            if text:
                paragraphs.append(text)

        title = ""
        try:
            core = ET.fromstring(archive.read("docProps/core.xml"))
            node = core.find(f"{DC}title")
            if node is not None and (node.text or "").strip():
                title = node.text.strip()
        except Exception:
            pass

    if not paragraphs:
        raise ValueError("This Word file contains no readable text.")
    return "\n\n".join(paragraphs), title


def _html_blocks(soup) -> list[str]:
    blocks = []
    for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre"]):
        text = re.sub(r"\s+", " ", tag.get_text(" ", strip=True)).strip()
        if text:
            blocks.append(text)
    if blocks:
        return blocks
    lines = [re.sub(r"\s+", " ", line).strip() for line in soup.get_text("\n").splitlines()]
    return [line for line in lines if line]


def extract_epub(path: Path) -> tuple[str, str]:
    import posixpath
    import zipfile
    import xml.etree.ElementTree as ET
    from bs4 import BeautifulSoup

    OPF = "{http://www.idpf.org/2007/opf}"
    DC = "{http://purl.org/dc/elements/1.1/}"
    CONTAINER = "{urn:oasis:names:tc:opendocument:xmlns:container}"

    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        opf_path = None
        if "META-INF/container.xml" in names:
            try:
                container = ET.fromstring(archive.read("META-INF/container.xml"))
                rootfile = container.find(f".//{CONTAINER}rootfile")
                if rootfile is not None:
                    opf_path = rootfile.get("full-path")
            except Exception:
                opf_path = None
        if not opf_path:
            opf_path = next((n for n in names if n.lower().endswith(".opf")), None)

        title = ""
        documents: list[str] = []
        if opf_path and opf_path in names:
            try:
                opf = ET.fromstring(archive.read(opf_path))
                base = posixpath.dirname(opf_path)
                title_node = opf.find(f".//{DC}title")
                if title_node is not None and (title_node.text or "").strip():
                    title = title_node.text.strip()
                manifest = {}
                for item in opf.findall(f".//{OPF}item"):
                    item_id = item.get("id")
                    href = item.get("href")
                    if item_id and href:
                        manifest[item_id] = urllib.parse.unquote(href)
                for itemref in opf.findall(f".//{OPF}itemref"):
                    href = manifest.get(itemref.get("idref"))
                    if href:
                        documents.append(posixpath.normpath(posixpath.join(base, href)))
                if not documents:
                    documents = list(manifest.values())
            except Exception:
                documents = []

        if not documents:
            documents = sorted(
                n for n in names
                if n.lower().endswith((".xhtml", ".html", ".htm"))
            )

        chapters: list[str] = []
        for name in documents:
            if name not in names:
                continue
            try:
                soup = BeautifulSoup(archive.read(name), "html.parser")
            except Exception:
                continue
            for tag in soup(["script", "style", "nav", "svg"]):
                tag.decompose()
            blocks = _html_blocks(soup)
            if blocks:
                chapters.append("\n\n".join(blocks))

    if not chapters:
        raise ValueError("This EPUB contains no readable text.")
    return "\n\n<<<PAGE>>>\n\n".join(chapters), title


def extract_html(path: Path) -> tuple[str, str]:
    from bs4 import BeautifulSoup

    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    soup = BeautifulSoup(text, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()
    blocks = _html_blocks(soup)
    if not blocks:
        raise ValueError("This HTML file contains no readable text.")
    return "\n\n".join(blocks), ""


def extract_text(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "big5", "latin-1"):
        try:
            return clean_text(raw.decode(encoding)), ""
        except UnicodeDecodeError:
            continue
    raise ValueError("Could not decode this text file.")


def parse_document(path: Path, suffix: str) -> tuple[str, str]:
    suffix = suffix.lower()
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix in (".docx", ".doc"):
        if suffix == ".doc":
            raise ValueError("Legacy .doc files are not supported. Save as .docx and try again.")
        return extract_docx(path)
    if suffix == ".epub":
        return extract_epub(path)
    if suffix in (".html", ".htm"):
        return extract_html(path)
    if suffix in (".txt", ".md", ".markdown", ".text", ".rtf"):
        if suffix == ".rtf":
            raise ValueError("RTF is not supported yet. Save as .txt or .docx.")
        text, title = extract_text(path)
        if suffix in (".md", ".markdown"):
            text = re.sub(r"```.*?```", "", text, flags=re.S)
            text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
            text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
            text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
            text = re.sub(r"[*_`>]", "", text)
            text = clean_text(text)
        return text, title
    raise ValueError(f"Unsupported format: {suffix or 'unknown'}")


# ------------------------------------------------------------------ dictionary


def http_json(url: str, timeout: float = 9.0):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Marginalia/1.0 (local reading app)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_wiktionary(word: str) -> dict | None:
    try:
        data = http_json(
            "https://api.dictionaryapi.dev/api/v2/entries/en/" + urllib.parse.quote(word)
        )
    except Exception:
        return None
    if not isinstance(data, list):
        return None

    phonetic = ""
    entries: list[dict] = []
    for item in data[:2]:
        if not isinstance(item, dict):
            continue
        if not phonetic:
            phonetic = (item.get("phonetic") or "").strip()
        if not phonetic:
            for p in item.get("phonetics", []) or []:
                if isinstance(p, dict) and p.get("text"):
                    phonetic = p["text"].strip()
                    break
        meanings = item.get("meanings") or []
        meanings = sorted(meanings, key=lambda m: len(m.get("definitions") or []), reverse=True)
        for meaning in meanings[:3]:
            defs = []
            for definition in (meaning.get("definitions") or [])[:4]:
                if not isinstance(definition, dict):
                    continue
                text = (definition.get("definition") or "").strip()
                if not text:
                    continue
                defs.append({"def": text, "example": (definition.get("example") or "").strip()})
            if defs:
                entries.append(
                    {
                        "pos": (meaning.get("partOfSpeech") or "").strip(),
                        "defs": defs,
                        "synonyms": (meaning.get("synonyms") or [])[:6],
                    }
                )
    if not entries:
        return None
    return {
        "name": "Wiktionary",
        "detail": "Free Dictionary API",
        "url": "https://en.wiktionary.org/wiki/" + urllib.parse.quote(word),
        "phonetic": phonetic,
        "entries": entries[:6],
    }


def fetch_merriam(word: str, key: str) -> dict | None:
    if not key:
        return None
    url = (
        "https://dictionaryapi.com/api/v3/references/learners/json/"
        f"{urllib.parse.quote(word)}?key={urllib.parse.quote(key)}"
    )
    try:
        data = http_json(url)
    except Exception:
        return None
    if not isinstance(data, list):
        return None

    entries: list[dict] = []
    phonetic = ""
    for item in data:
        if not isinstance(item, dict):
            continue
        hwi = item.get("hwi") or {}
        if not phonetic and hwi.get("prs"):
            phonetic = (hwi["prs"][0].get("mw") or "").strip()
        shortdefs = [str(x).strip() for x in (item.get("shortdef") or []) if str(x).strip()]
        if not shortdefs:
            continue
        entries.append(
            {
                "pos": (item.get("fl") or "").strip(),
                "defs": [{"def": d, "example": ""} for d in shortdefs[:4]],
                "synonyms": [],
            }
        )
        if len(entries) >= 4:
            break
    if not entries:
        return None
    return {
        "name": "Merriam-Webster Learner's",
        "detail": "authoritative learner dictionary",
        "url": "https://www.merriam-webster.com/dictionary/" + urllib.parse.quote(word),
        "phonetic": phonetic,
        "entries": entries,
    }


def lookup_english(word: str, mw_key: str) -> dict | None:
    mode = "mw" if mw_key else "wik"
    cache_key = f"{word.lower()}|{mode}"
    with connect() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at FROM lookup_cache WHERE key = ?", (cache_key,)
        ).fetchone()
    if row:
        try:
            age = time.time() - datetime.fromisoformat(row["fetched_at"]).timestamp()
            if age < 7 * 86400:
                payload = json.loads(row["payload"])
                if payload:
                    payload["cached"] = True
                    return payload
        except Exception:
            pass

    payload = None
    if mw_key:
        payload = fetch_merriam(word, mw_key)
    if not payload:
        payload = fetch_wiktionary(word)
    if payload:
        try:
            with connect() as conn:
                conn.execute(
                    "INSERT INTO lookup_cache(key, payload, fetched_at) VALUES(?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at",
                    (cache_key, json.dumps(payload, ensure_ascii=False), iso_now()),
                )
        except Exception:
            pass
    return payload


def helper_available() -> bool:
    return HELPER.exists() and os.access(HELPER, os.X_OK)


def lookup_oxford(word: str) -> dict | None:
    if not helper_available():
        return None
    try:
        result = subprocess.run(
            [str(HELPER), word, OXFORD_ID],
            capture_output=True,
            text=True,
            timeout=8,
        )
    except Exception:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        data = json.loads(result.stdout)
    except Exception:
        return None
    entries = []
    for entry in data.get("entries", []):
        text = re.sub(r"[ \t]+", " ", str(entry.get("text") or "")).strip()
        if text:
            entries.append({"name": entry.get("name") or "Oxford", "text": text})
    if not entries:
        return None
    # Keep the main Oxford entry first; don't flood the panel with extras.
    entries.sort(key=lambda e: 0 if "牛津" in e["name"] or "Oxford" in e["name"] else 1)
    return {
        "name": entries[0]["name"],
        "entries": entries[:2],
        "url": "dict://" + urllib.parse.quote(word),
    }


WORD_RE = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+$")
CJK_RE = re.compile(r"[\u3400-\u9fff]")


def normalize_word(raw: str) -> str:
    word = (raw or "").strip()
    word = word.replace("’", "'").replace("‘", "'")
    word = word.strip(" \t\n\r.,;:!?\"()[]{}<>«»“”‘’…—–-")
    return word


def lemma_candidates(word: str) -> list[str]:
    w = word.lower().strip("'")
    candidates = [word]
    if w.endswith("'s"):
        candidates.append(word[:-2])
    if w.endswith("ies") and len(w) > 4:
        candidates.append(word[:-3] + "y")
    if w.endswith("ves") and len(w) > 4:
        candidates.append(word[:-3] + "f")
        candidates.append(word[:-3] + "fe")
    for suffix, replacement in (
        ("ing", ""),
        ("ing", "e"),
        ("ed", ""),
        ("ed", "e"),
        ("es", ""),
        ("s", ""),
        ("ly", ""),
        ("er", ""),
        ("est", ""),
    ):
        if w.endswith(suffix) and len(w) > len(suffix) + 2:
            candidates.append(word[: -len(suffix)] + replacement)
    if len(word) > 3 and word[-1] == word[-2]:
        candidates.append(word[:-1])
    seen = set()
    out = []
    for c in candidates:
        c = c.strip()
        if c and c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return out


def _normalize_headword(text: str) -> str:
    text = text.replace("’", "'").replace("‘", "'").strip().lower()
    text = re.sub(r"^[^a-z0-9\u3400-\u9fff']+|[^a-z0-9\u3400-\u9fff']+$", "", text)
    return re.sub(r"\s+", " ", text)


def _mdx_header(path: Path) -> dict:
    try:
        raw = path.read_bytes()[:4]
        length = int.from_bytes(raw, "big")
        with path.open("rb") as handle:
            handle.seek(4)
            header = handle.read(length)
        text = header.decode("utf-16-le", errors="ignore")
        attrs = {}
        for key, value in re.findall(r'([A-Za-z][A-Za-z0-9_]*)="([^"]*)"', text):
            attrs[key] = value
        return attrs
    except Exception:
        return {}


def _mdx_to_text(html: str, name: str = "") -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "link", "meta"]):
        tag.decompose()
    text = soup.get_text(" ")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"'\s+s\b", "'s", text)
    if "collins" in name.lower():
        text = re.sub(r"^Definition of .*? Word Frequency\s+", "", text, flags=re.IGNORECASE)
        text = re.sub(
            r"\s*COBUILD Advanced English Dictionary\s*\.?\s*Copyright © HarperCollins Publishers.*$",
            "",
            text,
            flags=re.IGNORECASE,
        )
    return text.strip()


def _inline_text(element) -> str:
    if element is None:
        return ""
    text = element.get_text(" ", strip=True)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"'\s+s\b", "'s", text)
    return text.strip()


def _parse_collins(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for box in soup.select(".content-box-definition"):
        head = box.select_one(".h2_entry .orth")
        headword = _inline_text(head) if head else ""
        pron_parts = box.select(".mini_h2 .pron")
        phonetic = ""
        if pron_parts:
            sounds = [part.get_text("", strip=True).strip(" ,;") for part in pron_parts]
            sounds = [s for s in sounds if s]
            phonetic = " / " + " ; ".join(sounds) + " /"
        pos = _inline_text(box.select_one(".gramGrp .pos"))
        senses = []
        for sense in box.select(".sense"):
            definition = _inline_text(sense.select_one(".def"))
            if not definition:
                continue
            examples = [_inline_text(e.select_one(".quote")) for e in sense.select(".cit.type-example")]
            synonyms = [_inline_text(e) for e in sense.select(".thes .form")]
            senses.append(
                {
                    "def": definition,
                    "zh": "",
                    "examples": [{"text": e, "zh": ""} for e in examples if e],
                    "synonyms": [s for s in synonyms if s],
                }
            )
        if senses:
            out.append({"headword": headword, "phonetic": phonetic.strip(), "pos": pos, "senses": senses})
    return out


def _parse_oxford(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for entry in soup.select("span.entry"):
        head = entry.select_one(".h")
        headword = _inline_text(head) if head else ""
        phonetic = ""
        uk = entry.select_one(".phon-gb")
        us = entry.select_one(".phon-us, .phon-usgb")
        if uk or us:
            phonetic = " / " + (uk.get_text("", strip=True) if uk else "") + " ; NAmE " + (us.get_text("", strip=True) if us else "") + " /"
        pos = _inline_text(entry.select_one(".pos-g .pos, .pos"))
        senses = []
        for def_el in entry.select(".def-g"):
            d = def_el.select_one(".d")
            if not d:
                continue
            chinese = [_inline_text(x) for x in d.select(".oalecd8e_chn")]
            english = _inline_text(d)
            for zh in chinese:
                english = english.replace(zh, "").strip()
            if not english:
                continue
            senses.append(
                {
                    "def": english,
                    "zh": "；".join([x for x in chinese if x]),
                    "examples": [],
                    "synonyms": [],
                }
            )
        examples = []
        for example in entry.select(".x-g"):
            if example.find_parent(class_="dr-g"):
                continue
            text = _inline_text(example.select_one(".x"))
            zh = "；".join(_inline_text(x) for x in example.select(".oalecd8e_chn") if _inline_text(x))
            if text:
                examples.append({"text": text, "zh": zh})
        if senses:
            senses[0]["examples"] = examples[:6]
            out.append({"headword": headword.replace("·", ""), "phonetic": phonetic.strip(), "pos": pos, "senses": senses})
    return out


def parse_mdx_data(html: str, source_name: str) -> list[dict]:
    try:
        if "collins" in source_name.lower():
            return _parse_collins(html)
        return _parse_oxford(html)
    except Exception:
        return []


def _mdx_source_name(path: Path, title: str) -> tuple[str, str]:
    lower = f"{path.name} {title}".lower()
    if "collins" in lower:
        return "Collins COBUILD Advanced Learner's Dictionary", "en-en"
    if "oxford" in lower or "牛津" in lower:
        return "Oxford Advanced Learner's English-Chinese Dictionary (8th ed.)", "en-zh"
    return (title or path.stem), "en-en"


def index_mdx_file(path: Path, force: bool = False) -> dict:
    import types

    if "lzo" not in sys.modules:
        sys.modules["lzo"] = types.ModuleType("lzo")
    from readmdict import MDX

    stat = path.stat()
    with connect() as conn:
        existing = conn.execute(
            "SELECT * FROM local_dict_sources WHERE filename = ?", (path.name,)
        ).fetchone()
        has_structured = False
        if existing:
            has_structured = bool(
                conn.execute(
                    "SELECT 1 FROM local_dict_entries WHERE source_id = ? AND data IS NOT NULL LIMIT 1",
                    (existing["id"],),
                ).fetchone()
            )
        if existing and not force and has_structured and abs(float(existing["mtime"]) - stat.st_mtime) < 1:
            return {
                "filename": path.name,
                "title": existing["title"],
                "entries": existing["entries"],
                "skipped": True,
            }

        header = _mdx_header(path)
        title = header.get("Title") or path.stem
        name, language = _mdx_source_name(path, title)

        mdx = MDX(str(path))
        if existing:
            conn.execute("DELETE FROM local_dict_entries WHERE source_id = ?", (existing["id"],))
            conn.execute("DELETE FROM local_dict_sources WHERE id = ?", (existing["id"],))
        cur = conn.execute(
            "INSERT INTO local_dict_sources(filename, title, language, entries, mtime, imported_at) "
            "VALUES(?, ?, ?, 0, ?, ?)",
            (path.name, name, language, stat.st_mtime, iso_now()),
        )
        source_id = cur.lastrowid

        batch = []
        count = 0
        for key, value in mdx.items():
            try:
                headword = key.decode("utf-8", errors="ignore").strip()
                html = value.decode("utf-8", errors="ignore")
            except Exception:
                continue
            if not headword or not html or html.startswith("@@@LINK="):
                continue
            normalized = _normalize_headword(headword)
            if not normalized:
                continue
            structured = parse_mdx_data(html, name)
            if structured:
                text = ""
                data_json = json.dumps(structured, ensure_ascii=False)
            else:
                text = _mdx_to_text(html, name)
                data_json = None
                if not text:
                    continue
            batch.append((source_id, headword, normalized, text, data_json))
            count += 1
            if len(batch) >= 1000:
                conn.executemany(
                    "INSERT INTO local_dict_entries(source_id, headword, normalized, text, data) VALUES(?, ?, ?, ?, ?)",
                    batch,
                )
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany(
                "INSERT INTO local_dict_entries(source_id, headword, normalized, text, data) VALUES(?, ?, ?, ?, ?)",
                batch,
            )
            conn.commit()
        conn.execute(
            "UPDATE local_dict_sources SET entries = ? WHERE id = ?", (count, source_id)
        )
    return {"filename": path.name, "title": name, "entries": count, "skipped": False}


def dictionary_files() -> list[Path]:
    seen: set[str] = set()
    files: list[Path] = []
    for folder in DICT_SEARCH_DIRS:
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.mdx")):
            if path.name.lower() in seen:
                continue
            seen.add(path.name.lower())
            files.append(path)
    return files


def local_dictionary_data() -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, filename, title, language, entries, imported_at FROM local_dict_sources ORDER BY id"
        ).fetchall()
    sources = [dict(row) for row in rows]
    indexed = {s["filename"].lower() for s in sources}
    files = []
    for path in dictionary_files():
        files.append(
            {
                "filename": path.name,
                "path": str(path),
                "size": path.stat().st_size,
                "indexed": path.name.lower() in indexed,
            }
        )
    return {"folder": str(DICT_DIR), "sources": sources, "files": files}


def index_all_dictionaries(force: bool = False) -> dict:
    results = []
    for path in dictionary_files():
        try:
            results.append(index_mdx_file(path, force=force))
        except Exception as exc:
            results.append({"filename": path.name, "error": str(exc)})
    return {"results": results}


def local_dictionary_lookup(word: str) -> list[dict]:
    candidates = []
    for candidate in lemma_candidates(word):
        normalized = _normalize_headword(candidate)
        if normalized and normalized not in candidates:
            candidates.append(normalized)
    if not candidates:
        return []
    placeholders = ",".join("?" for _ in candidates)
    with connect() as conn:
        rows = conn.execute(
            "SELECT e.headword, e.text, e.data, s.id AS source_id, s.title, s.language "
            "FROM local_dict_entries e JOIN local_dict_sources s ON s.id = e.source_id "
            f"WHERE e.normalized IN ({placeholders}) ORDER BY s.id, e.id LIMIT 40",
            candidates,
        ).fetchall()
    grouped: dict[int, dict] = {}
    for row in rows:
        source = grouped.setdefault(
            row["source_id"],
            {"name": row["title"], "language": row["language"], "entries": []},
        )
        data = None
        if row["data"]:
            try:
                data = json.loads(row["data"])
            except Exception:
                data = None
        item = {"headword": row["headword"], "text": "" if data else row["text"], "data": data}
        if item not in source["entries"]:
            source["entries"].append(item)
    return list(grouped.values())


def build_lookup(raw_word: str) -> dict:
    word = normalize_word(raw_word)
    if not word or len(word) > 60:
        raise ValueError("Select a single word or a short phrase.")
    if not re.search(r"[A-Za-z\u3400-\u9fff]", word):
        raise ValueError("Selection does not look like a word.")
    if len(word.split()) > 4:
        raise ValueError("Select a single word or a short phrase.")

    mw_key = get_setting("mw_key", "").strip()
    is_cjk = bool(CJK_RE.search(word))
    local = local_dictionary_lookup(word)
    has_local_english = any(source["language"] == "en-en" for source in local)
    has_local_bilingual = any(source["language"] == "en-zh" for source in local)

    english = None
    chosen = word
    if not is_cjk and not has_local_english:
        for candidate in lemma_candidates(word):
            english = lookup_english(candidate, mw_key)
            if english:
                chosen = candidate
                break

    if has_local_bilingual:
        chinese = None
    else:
        chinese = lookup_oxford(word) or (lookup_oxford(chosen) if chosen != word else None)

    if not english and not chinese and not local:
        raise LookupError(
            "No entry found. Try the base form of the word, check spelling, or add a Merriam-Webster key in Settings."
        )

    with connect() as conn:
        saved = conn.execute(
            "SELECT id FROM notebook WHERE word = ? COLLATE NOCASE", (word,)
        ).fetchone()

    return {
        "word": word,
        "lemma": chosen,
        "phonetic": (english or {}).get("phonetic", ""),
        "english": english,
        "chinese": chinese,
        "local": local,
        "saved": bool(saved),
        "oxford_available": helper_available(),
    }


# ------------------------------------------------------------------ notebook


def parse_entry_row(row: sqlite3.Row) -> dict:
    entry = dict(row)
    entry["english"] = json.loads(entry.get("english") or "[]")
    entry["srs"] = json.loads(entry.get("srs") or "{}")
    entry["stats"] = json.loads(entry.get("stats") or "{}")
    entry["known"] = bool(entry.get("known"))
    entry["status"] = status_of(entry)
    entry["due"] = is_due(entry)
    entry["interval"] = entry["srs"].get("interval", 0)
    entry["next_due"] = entry["srs"].get("due", 0)
    return entry


def status_of(entry: dict) -> str:
    if entry.get("known"):
        return "known"
    srs = entry.get("srs") or {}
    if srs.get("state") == "new":
        return "new"
    if srs.get("state") in ("learning", "relearning"):
        return "learning"
    return "review"


def is_due(entry: dict) -> bool:
    if entry.get("known"):
        return False
    srs = entry.get("srs") or {}
    return srs.get("state") == "new" or int(srs.get("due") or 0) <= now_ms()


def primary_definition(entry: dict) -> str:
    for source in entry.get("english") or []:
        for group in source.get("entries") or []:
            for d in group.get("defs") or []:
                if d.get("def"):
                    return d["def"]
    return ""


def notebook_entry(entry: dict) -> dict:
    return {
        "id": entry["id"],
        "word": entry["word"],
        "lemma": entry.get("lemma") or entry["word"],
        "phonetic": entry.get("phonetic") or "",
        "english": entry.get("english") or [],
        "chinese": entry.get("chinese") or "",
        "context": entry.get("context") or "",
        "document_id": entry.get("document_id"),
        "created_at": entry.get("created_at") or "",
        "srs": entry.get("srs") or blank_srs(),
        "stats": entry.get("stats") or blank_stats(),
        "known": bool(entry.get("known")),
        "status": entry.get("status") or "new",
        "due": bool(entry.get("due")),
        "primary_def": primary_definition(entry),
        "interval": entry.get("interval", 0),
        "next_due": entry.get("next_due", 0),
    }


# ------------------------------------------------------------------ static serving


MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Marginalia/1.0"

    def log_message(self, fmt, *args):
        # Keep the terminal readable; errors still go through send_error.
        if args and str(args[0]).startswith("4"):
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    # ------------------------------------------------------------------ helpers

    def send_json(self, payload, status: int = 200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_error_json(self, message: str, status: int = 400):
        self.send_json({"error": message}, status)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2 * 1024 * 1024:
            raise ValueError("Request too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            raise ValueError("Invalid JSON.") from exc

    def route(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path

    # ------------------------------------------------------------------ GET

    def do_GET(self):
        path = self.route()
        try:
            if path == "/" or path == "/index.html":
                return self.serve_file(STATIC / "index.html")
            if path.startswith("/static/"):
                return self.serve_file(STATIC / path[len("/static/"):])
            if path == "/api/documents":
                return self.list_documents()
            match = re.fullmatch(r"/api/documents/(\d+)/highlights", path)
            if match:
                return self.list_highlights(int(match.group(1)))
            if path == "/api/highlights":
                return self.list_highlights(None)
            if re.fullmatch(r"/api/documents/\d+", path):
                return self.get_document(int(path.rsplit("/", 1)[1]))
            if path == "/api/notebook":
                return self.list_notebook()
            if path == "/api/review":
                return self.review_queue()
            if path == "/api/stats":
                return self.stats()
            if path == "/api/settings":
                return self.get_settings()
            if path == "/api/local-dictionaries":
                return self.send_json(local_dictionary_data())
            if path == "/api/export":
                return self.export_notebook()
            if path == "/api/health":
                return self.send_json(
                    {
                        "ok": True,
                        "oxford": helper_available(),
                        "mw": bool(get_setting("mw_key", "").strip()),
                    }
                )
            return self.send_error_json("Not found.", 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), 500)

    def serve_file(self, path: Path):
        path = path.resolve()
        if not str(path).startswith(str(STATIC.resolve())) or not path.is_file():
            return self.send_error_json("Not found.", 404)
        raw = path.read_bytes()
        mime = MIME.get(path.suffix.lower()) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def list_documents(self):
        with connect() as conn:
            rows = conn.execute(
                "SELECT id, title, filename, format, created_at, last_opened, progress, "
                "length(text) AS chars FROM documents ORDER BY id DESC"
            ).fetchall()
        self.send_json({"documents": [dict(r) for r in rows]})

    def list_highlights(self, doc_id: int | None):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if doc_id is None and query.get("document_id"):
            try:
                doc_id = int(query["document_id"][0])
            except Exception:
                doc_id = None
        with connect() as conn:
            if doc_id is None:
                rows = conn.execute(
                    "SELECT h.*, d.title AS document_title, d.format AS document_format "
                    "FROM highlights h JOIN documents d ON d.id = h.document_id "
                    "ORDER BY h.document_id, h.paragraph_index, h.start_offset"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT h.*, d.title AS document_title, d.format AS document_format "
                    "FROM highlights h JOIN documents d ON d.id = h.document_id "
                    "WHERE h.document_id = ? ORDER BY h.paragraph_index, h.start_offset",
                    (doc_id,),
                ).fetchall()
        entries = [dict(row) for row in rows]
        self.send_json({"highlights": entries, "count": len(entries)})

    def add_highlight(self, doc_id: int):
        body = self.read_json()
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone():
                raise ValueError("Document not found.")
        try:
            paragraph_index = int(body.get("paragraph_index"))
            start = int(body.get("start_offset"))
            end = int(body.get("end_offset"))
        except Exception as exc:
            raise ValueError("Invalid highlight range.") from exc
        quote = str(body.get("quote") or "")
        note = str(body.get("note") or "").strip()[:1000]
        if not quote.strip():
            raise ValueError("The selected text is empty.")
        if paragraph_index < 0 or start < 0 or end <= start or len(quote) > 4000:
            raise ValueError("Invalid highlight range.")
        with connect() as conn:
            cur = conn.execute(
                "INSERT INTO highlights(document_id, paragraph_index, start_offset, end_offset, quote, note, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (doc_id, paragraph_index, start, end, quote, note, iso_now()),
            )
            row = conn.execute(
                "SELECT h.*, d.title AS document_title, d.format AS document_format "
                "FROM highlights h JOIN documents d ON d.id = h.document_id WHERE h.id = ?",
                (cur.lastrowid,),
            ).fetchone()
        self.send_json({"highlight": dict(row)})

    def get_document(self, doc_id: int):
        with connect() as conn:
            row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
            if not row:
                return self.send_error_json("Document not found.", 404)
            conn.execute("UPDATE documents SET last_opened = ? WHERE id = ?", (iso_now(), doc_id))
        payload = dict(row)
        try:
            payload["report"] = json.loads(payload.get("report") or "{}")
        except Exception:
            payload["report"] = {}
        self.send_json({"document": payload})

    def list_notebook(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("q", [""])[0].strip()
        with connect() as conn:
            if query:
                like = f"%{query}%"
                rows = conn.execute(
                    "SELECT * FROM notebook WHERE word LIKE ? OR english LIKE ? OR chinese LIKE ? OR context LIKE ? "
                    "ORDER BY id DESC",
                    (like, like, like, like),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM notebook ORDER BY id DESC").fetchall()
        entries = [notebook_entry(parse_entry_row(r)) for r in rows]
        self.send_json({"entries": entries, "count": len(entries)})

    def review_queue(self):
        with connect() as conn:
            rows = conn.execute("SELECT * FROM notebook WHERE known = 0 ORDER BY id ASC").fetchall()
        entries = [notebook_entry(parse_entry_row(r)) for r in rows]
        now = now_ms()
        due = [e for e in entries if e["srs"].get("state") == "new" or int(e["srs"].get("due") or 0) <= now]
        due.sort(key=lambda e: (0 if e["srs"].get("state") == "new" else 1, e["srs"].get("due") or 0))
        self.send_json(
            {
                "queue": due[:50],
                "due_count": len(due),
                "total": len(entries),
                "new_count": sum(1 for e in entries if e["srs"].get("state") == "new"),
                "learning_count": sum(1 for e in entries if e["status"] == "learning"),
                "known_count": sum(1 for e in entries if e["known"]),
            }
        )

    def stats(self):
        with connect() as conn:
            total = conn.execute("SELECT COUNT(*) AS n FROM notebook").fetchone()["n"]
            known = conn.execute("SELECT COUNT(*) AS n FROM notebook WHERE known = 1").fetchone()["n"]
            due = 0
            for row in conn.execute("SELECT srs, known FROM notebook WHERE known = 0").fetchall():
                try:
                    srs = json.loads(row["srs"])
                except Exception:
                    continue
                if srs.get("state") == "new" or int(srs.get("due") or 0) <= now_ms():
                    due += 1
            docs = conn.execute("SELECT COUNT(*) AS n FROM documents").fetchone()["n"]
            highlights = conn.execute("SELECT COUNT(*) AS n FROM highlights").fetchone()["n"]
        self.send_json(
            {
                "words": total,
                "known": known,
                "due": due,
                "documents": docs,
                "highlights": highlights,
                "oxford": helper_available(),
                "mw": bool(get_setting("mw_key", "").strip()),
            }
        )

    def get_settings(self):
        self.send_json(
            {
                "mw_key": get_setting("mw_key", ""),
                "font_size": int(get_setting("font_size", "18")),
                "theme": get_setting("theme", "auto"),
                "oxford_available": helper_available(),
            }
        )

    def export_notebook(self):
        with connect() as conn:
            rows = conn.execute("SELECT * FROM notebook ORDER BY id ASC").fetchall()
            highlight_rows = conn.execute(
                "SELECT h.*, d.title AS document_title FROM highlights h "
                "JOIN documents d ON d.id = h.document_id "
                "ORDER BY h.document_id, h.paragraph_index, h.start_offset"
            ).fetchall()
        entries = []
        for row in rows:
            entry = notebook_entry(parse_entry_row(row))
            for key in ("status", "due", "primary_def"):
                entry.pop(key, None)
            entries.append(entry)
        highlights = [dict(row) for row in highlight_rows]
        payload = {
            "app": "Marginalia",
            "version": 2,
            "exported_at": iso_now(),
            "notebook": entries,
            "highlights": highlights,
        }
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="marginalia-notebook-{datetime.now().strftime("%Y-%m-%d")}.json"',
        )
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    # ------------------------------------------------------------------ POST

    def do_POST(self):
        path = self.route()
        try:
            if path == "/api/upload":
                return self.upload()
            if path == "/api/lookup":
                return self.lookup()
            if path == "/api/notebook":
                return self.add_notebook()
            if path == "/api/settings":
                return self.save_settings()
            if path == "/api/local-dictionaries/index":
                return self.index_dictionaries()
            if path == "/api/local-dictionaries/open":
                DICT_DIR.mkdir(parents=True, exist_ok=True)
                try:
                    subprocess.Popen(["open", str(DICT_DIR)])
                except Exception as exc:
                    raise ValueError(f"Could not open the dictionary folder: {exc}")
                return self.send_json({"ok": True, "folder": str(DICT_DIR)})
            match = re.fullmatch(r"/api/documents/(\d+)/highlights", path)
            if match:
                return self.add_highlight(int(match.group(1)))
            match = re.fullmatch(r"/api/documents/(\d+)/progress", path)
            if match:
                return self.save_progress(int(match.group(1)))
            match = re.fullmatch(r"/api/notebook/(\d+)", path)
            if match:
                return self.update_notebook(int(match.group(1)))
            match = re.fullmatch(r"/api/notebook/(\d+)/review", path)
            if match:
                return self.review(int(match.group(1)))
            return self.send_error_json("Not found.", 404)
        except ValueError as exc:
            self.send_error_json(str(exc), 400)
        except LookupError as exc:
            self.send_error_json(str(exc), 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), 500)

    def upload(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("Empty upload.")
        if length > MAX_UPLOAD:
            raise ValueError("File is too large (limit 120 MB).")
        raw_name = self.headers.get("X-Filename") or "document"
        try:
            filename = urllib.parse.unquote(raw_name)
        except Exception:
            filename = "document"
        filename = Path(filename).name.strip() or "document"
        suffix = Path(filename).suffix.lower()
        if not suffix:
            raise ValueError("The file needs an extension (.pdf, .docx, .epub, .txt).")

        temp_path = DATA / f"upload-{int(time.time() * 1000)}-{os.getpid()}{suffix}"
        try:
            remaining = length
            with temp_path.open("wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)

            text, meta_title = parse_document(temp_path, suffix)
            text, report = polish_text(text, suffix.lstrip(".").lower())
            if len(text) < 20:
                raise ValueError("No readable text was found in this file.")
            title = (meta_title or Path(filename).stem).strip()[:160]
            title = re.sub(r"[_]+", " ", title)
            with connect() as conn:
                cur = conn.execute(
                    "INSERT INTO documents(title, filename, format, text, created_at, progress, report) "
                    "VALUES(?, ?, ?, ?, ?, 0, ?)",
                    (title, filename, suffix.lstrip(".").upper(), text, iso_now(), json.dumps(report, ensure_ascii=False)),
                )
                doc_id = cur.lastrowid
            self.send_json(
                {
                    "document": {
                        "id": doc_id,
                        "title": title,
                        "format": suffix.lstrip(".").upper(),
                        "chars": len(text),
                        "report": report,
                    }
                }
            )
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

    def lookup(self):
        body = self.read_json()
        word = str(body.get("word") or "")
        payload = build_lookup(word)
        self.send_json(payload)

    def save_progress(self, doc_id: int):
        body = self.read_json()
        progress = float(body.get("progress") or 0)
        progress = max(0.0, min(1.0, progress))
        with connect() as conn:
            conn.execute("UPDATE documents SET progress = ?, last_opened = ? WHERE id = ?", (progress, iso_now(), doc_id))
        self.send_json({"ok": True})

    def add_notebook(self):
        body = self.read_json()
        word = normalize_word(str(body.get("word") or ""))
        if not word:
            raise ValueError("Missing word.")
        english = body.get("english") or []
        chinese = str(body.get("chinese") or "").strip()
        context = str(body.get("context") or "").strip()[:1200]
        phonetic = str(body.get("phonetic") or "").strip()
        lemma = normalize_word(str(body.get("lemma") or word)) or word
        doc_id = body.get("document_id")
        try:
            doc_id = int(doc_id) if doc_id else None
        except Exception:
            doc_id = None

        if not english and not chinese:
            raise ValueError("Nothing to save: the lookup has no definition.")

        srs = blank_srs()
        stats = blank_stats()
        with connect() as conn:
            existing = conn.execute(
                "SELECT id FROM notebook WHERE word = ? COLLATE NOCASE", (word,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE notebook SET english = ?, chinese = ?, context = ?, phonetic = ?, document_id = ? WHERE id = ?",
                    (
                        json.dumps(english, ensure_ascii=False),
                        chinese,
                        context,
                        phonetic,
                        doc_id,
                        existing["id"],
                    ),
                )
                self.send_json({"ok": True, "id": existing["id"], "existing": True})
                return
            cur = conn.execute(
                "INSERT INTO notebook(word, lemma, phonetic, english, chinese, context, document_id, created_at, srs, stats) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    word,
                    lemma,
                    phonetic,
                    json.dumps(english, ensure_ascii=False),
                    chinese,
                    context,
                    doc_id,
                    iso_now(),
                    json.dumps(srs),
                    json.dumps(stats),
                ),
            )
            entry_id = cur.lastrowid
        self.send_json({"ok": True, "id": entry_id, "existing": False})

    def update_notebook(self, entry_id: int):
        body = self.read_json()
        if "known" in body:
            known = 1 if body.get("known") else 0
            with connect() as conn:
                conn.execute("UPDATE notebook SET known = ? WHERE id = ?", (known, entry_id))
            return self.send_json({"ok": True})
        if body.get("delete"):
            with connect() as conn:
                conn.execute("DELETE FROM notebook WHERE id = ?", (entry_id,))
            return self.send_json({"ok": True})
        return self.send_error_json("Nothing to update.", 400)

    def review(self, entry_id: int):
        body = self.read_json()
        grade = int(body.get("grade") or 0)
        if grade not in (1, 2, 3, 4):
            raise ValueError("Grade must be 1–4.")
        with connect() as conn:
            row = conn.execute("SELECT * FROM notebook WHERE id = ?", (entry_id,)).fetchone()
            if not row:
                return self.send_error_json("Word not found.", 404)
            srs = json.loads(row["srs"] or "{}")
            stats = json.loads(row["stats"] or "{}")
            new_srs = schedule(srs, grade, now_ms())
            stats["seen"] = int(stats.get("seen") or 0) + 1
            if grade >= 2:
                stats["correct"] = int(stats.get("correct") or 0) + 1
            conn.execute(
                "UPDATE notebook SET srs = ?, stats = ? WHERE id = ?",
                (json.dumps(new_srs), json.dumps(stats), entry_id),
            )
        self.send_json({"ok": True, "srs": new_srs, "interval": format_delay(new_srs["due"] - now_ms())})

    def index_dictionaries(self):
        body = self.read_json()
        result = index_all_dictionaries(force=bool(body.get("force")))
        self.send_json(result)

    def save_settings(self):
        body = self.read_json()
        if "mw_key" in body:
            key = str(body.get("mw_key") or "").strip()
            if key and not re.fullmatch(r"[A-Za-z0-9\-]{8,80}", key):
                raise ValueError("That does not look like a Merriam-Webster key.")
            set_setting("mw_key", key)
            # A new key means cached Wiktionary results may no longer reflect the chosen source.
            with connect() as conn:
                conn.execute("DELETE FROM lookup_cache")
        if "font_size" in body:
            size = max(15, min(24, int(body.get("font_size") or 18)))
            set_setting("font_size", str(size))
        if "theme" in body:
            theme = str(body.get("theme") or "auto")
            if theme not in ("auto", "light", "dark"):
                theme = "auto"
            set_setting("theme", theme)
        self.get_settings()

    # ------------------------------------------------------------------ DELETE

    def do_DELETE(self):
        path = self.route()
        match = re.fullmatch(r"/api/documents/(\d+)", path)
        if match:
            doc_id = int(match.group(1))
            with connect() as conn:
                conn.execute("DELETE FROM highlights WHERE document_id = ?", (doc_id,))
                conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
            return self.send_json({"ok": True})
        match = re.fullmatch(r"/api/highlights/(\d+)", path)
        if match:
            with connect() as conn:
                conn.execute("DELETE FROM highlights WHERE id = ?", (int(match.group(1)),))
            return self.send_json({"ok": True})
        match = re.fullmatch(r"/api/notebook/(\d+)", path)
        if match:
            with connect() as conn:
                conn.execute("DELETE FROM notebook WHERE id = ?", (int(match.group(1)),))
            return self.send_json({"ok": True})
        return self.send_error_json("Not found.", 404)


# ------------------------------------------------------------------ startup


def ensure_helper() -> bool:
    if helper_available():
        return True
    if not shutil.which("swiftc"):
        print("! Swift is not available; local dictionary and PDF helpers are disabled.")
        return False
    cache = DATA / "swift-cache"
    cache.mkdir(exist_ok=True)
    try:
        if not helper_available() and HELPER_SRC.exists():
            print("Building the local Oxford dictionary helper…", flush=True)
            subprocess.run(
                [
                    "swiftc", "-O", "-module-cache-path", str(cache),
                    str(HELPER_SRC), "-o", str(HELPER),
                    "-framework", "CoreServices",
                ],
                check=True, capture_output=True, timeout=120,
            )
            os.chmod(HELPER, 0o755)
        if not PDF_HELPER.exists() and PDF_HELPER_SRC.exists():
            print("Building the native PDF text helper…", flush=True)
            subprocess.run(
                [
                    "swiftc", "-O", "-module-cache-path", str(cache),
                    str(PDF_HELPER_SRC), "-o", str(PDF_HELPER),
                    "-framework", "PDFKit", "-framework", "AppKit",
                ],
                check=True, capture_output=True, timeout=120,
            )
            os.chmod(PDF_HELPER, 0o755)
        return helper_available()
    except Exception as exc:
        print(f"! Could not build local helper: {exc}")
        return helper_available()


def find_port(start: int) -> int:
    import socket

    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free local port found.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Marginalia local reader")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--index-dictionaries", action="store_true", help="Index local .mdx files and exit.")
    args = parser.parse_args()

    init_db()
    if args.index_dictionaries:
        print(json.dumps(index_all_dictionaries(force=True), ensure_ascii=False, indent=2))
        return
    ensure_helper()
    if FROZEN:
        try:
            log = open(DATA / "server.log", "a", buffering=1, encoding="utf-8")
            sys.stdout = log
            sys.stderr = log
        except Exception:
            pass
    port = find_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print()
    print("  Marginalia is running.")
    print(f"  Open: {url}")
    print("  Close this Terminal window to stop the reader.")
    print()
    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
