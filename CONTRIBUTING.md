# Contributing

Thanks for considering a contribution.

## Ground rules

- Do not commit dictionary data (`.mdx`, `.mdd`, `.eubak`) or exported copies of
  commercial dictionaries. They are licensed content and are ignored by
  `.gitignore`.
- Do not add API keys or personal reading data to the repository.
- Keep the app local-first: no telemetry, no accounts, no cloud sync.

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py --no-browser
```

The UI is plain HTML/CSS/JS in `static/`. The backend is a single `app.py`
using `http.server` and SQLite.

## Pull requests

- Keep changes focused and describe the user-facing effect.
- Run `python -m py_compile app.py` before submitting.
- If you change PDF extraction, test a text-based PDF with running heads and
  page numbers, and a PDF without them.
- If you change dictionary parsing, do not invent data. Document the source and
  the license.
