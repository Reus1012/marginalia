# Changelog

## 1.1.0 — 2026-11-06

- Added a Chinese-first usage guide for learners (`README.md`) and kept the
  English guide as `README.en.md`.

- Added a text-check pass before reading: joins hard-wrapped lines, repairs
  hyphenation, merges broken paragraphs, removes repeated page furniture, and
  reports repairs/warnings.
- Added fluorescent sentence highlights and a searchable Excerpts view grouped
  by book, with jump-back and delete.

- Redesigned the dictionary panel with source tabs and structured local
  entries (headword, part of speech, senses, examples, Chinese, synonyms).

- Added local MDX dictionary import (Collins COBUILD, Oxford Advanced Learner's).
- Local dictionaries take precedence over online/macOS sources when indexed.

- Rebuilt PDF text extraction around macOS PDFKit, with a pypdf fallback.
- Removed repeated running heads and footers, page numbers, publisher metadata,
  and small bottom-of-page notes from PDF text.
- Added a standalone Apple Silicon macOS app build (`Marginalia.app`).
- Added repository-ready packaging: GPL-3.0 license, ignore rules, build scripts,
  screenshots, and a reader's guide.
- Clarified dictionary sourcing and the limits of `.eubak` backups.

## 1.0.0 — 2026-11-06

- Local library for PDF, DOCX, EPUB, TXT, Markdown, and HTML.
- Selection lookup with English and Oxford Chinese definitions.
- Vocabulary notebook with saved context and spaced review.
- Local SQLite storage, JSON export, light/dark themes, and mobile layout.
