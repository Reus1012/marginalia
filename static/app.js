/* Marginalia — local reader, dictionary, notebook. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const state = {
    view: 'library',
    docs: [],
    notebook: [],
    stats: { words: 0, known: 0, due: 0, documents: 0, oxford: false, mw: false },
    settings: { mw_key: '', font_size: 18, theme: 'auto' },
    doc: null,
    lookup: null,
    lookupContext: '',
    lookupSeq: 0,
    lastSelection: '',
    notebookQuery: '',
    localDicts: { folder: '', sources: [], files: [] },
    highlights: [],
    allHighlights: [],
    selection: null,
    pendingParagraph: null,
    excerptQuery: '',
    excerptDoc: '',
    report: null,
    review: null,
    timer: null
  };

  const DAY = 86400000;
  const MINUTE = 60000;

  // ---------------------------------------------------------------- api

  async function api(path, options = {}) {
    const opts = { ...options };
    if (opts.body && !(opts.body instanceof Blob) && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    const response = await fetch(path, opts);
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `Request failed (${response.status})`);
    }
    return data;
  }

  function toast(message, ms = 2600) {
    const root = $('#toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    root.appendChild(el);
    window.setTimeout(() => {
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 200);
    }, ms);
  }

  // ---------------------------------------------------------------- theme

  function applyTheme() {
    const mode = state.settings.theme || 'auto';
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = mode === 'dark' || (mode === 'auto' && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#15140f' : '#f3eee4');
    const use = $('#themeToggle use');
    if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
  }

  function applyFont() {
    document.documentElement.style.setProperty('--reader-size', `${state.settings.font_size || 18}px`);
  }

  async function saveSettings(partial) {
    const body = { ...partial };
    try {
      const data = await api('/api/settings', { method: 'POST', body });
      state.settings = data;
      applyTheme();
      applyFont();
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }

  // ---------------------------------------------------------------- boot

  async function init() {
    bindEvents();
    try {
      state.settings = await api('/api/settings');
    } catch (error) {
      // Defaults are fine; the server may still be starting.
    }
    applyTheme();
    applyFont();
    await refreshAll();
    showView('library');
  }

  async function refreshAll() {
    await Promise.all([loadDocs(), loadNotebook(), loadStats(), loadLocalDicts(), loadAllHighlights()]);
  }

  async function loadAllHighlights() {
    try {
      const data = await api('/api/highlights');
      state.allHighlights = data.highlights || [];
      const count = state.allHighlights.length;
      const nav = $('#navHighlightCount');
      if (nav) nav.textContent = count ? String(count) : '';
      if (state.view === 'excerpts') renderExcerpts();
    } catch (error) {
      // Highlights are optional.
    }
  }

  async function loadDocs() {
    try {
      const data = await api('/api/documents');
      state.docs = data.documents || [];
      renderDocs();
    } catch (error) {
      toast(error.message);
    }
  }

  async function loadStats() {
    try {
      state.stats = await api('/api/stats');
      renderStats();
    } catch (error) {
      // Ignore transient failures.
    }
  }

  async function loadNotebook(query = state.notebookQuery) {
    try {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
      const data = await api(`/api/notebook${suffix}`);
      state.notebook = data.entries || [];
      renderNotebook();
      renderRecentWords();
    } catch (error) {
      toast(error.message);
    }
  }

  async function loadLocalDicts() {
    try {
      state.localDicts = await api('/api/local-dictionaries');
    } catch (error) {
      // Local dictionaries are optional.
    }
  }

  function localDictSettingsHTML() {
    const data = state.localDicts || { folder: '', sources: [], files: [] };
    const sources = data.sources || [];
    const files = data.files || [];
    const sourceRows = sources.length
      ? sources.map((source) => `<div class="local-dict-row"><span>${esc(source.title)}</span><small>${source.language === 'en-zh' ? 'EN → ZH' : 'EN → EN'} · ${source.entries.toLocaleString()} entries</small></div>`).join('')
      : '<div class="settings-hint">No local dictionaries indexed yet.</div>';
    const pending = files.filter((file) => !file.indexed);
    const pendingRows = pending.length
      ? `<div class="settings-hint" style="margin-top:8px">Found ${plural(pending.length, 'file', 'files')} not indexed: ${pending.map((f) => `<code>${esc(f.filename)}</code>`).join(', ')}</div>`
      : '';
    return `
      <div class="settings-section">
        <div class="settings-label">Local dictionaries</div>
        <div class="settings-hint">Put licensed <code>.mdx</code> files in this folder, then index them. They stay on this Mac and are never uploaded.</div>
        <div class="local-dict-folder"><code>${esc(data.folder || '')}</code></div>
        <div class="local-dict-list">${sourceRows}</div>
        ${pendingRows}
        <div class="settings-row" style="margin-top:10px">
          <button class="btn btn-outline btn-sm" data-open-dict>Open folder</button>
          <button class="btn btn-primary btn-sm" data-index-dict>Index dictionaries</button>
        </div>
      </div>`;
  }

  function renderStats() {
    $('#statDocs').textContent = state.stats.documents || 0;
    $('#statWords').textContent = state.stats.words || 0;
    $('#statDue').textContent = state.stats.due || 0;
    $('#navNotebookCount').textContent = state.stats.words ? String(state.stats.words) : '';
    $('#navHighlightCount').textContent = state.stats.highlights ? String(state.stats.highlights) : '';
    $('#navDueCount').textContent = state.stats.due ? String(state.stats.due) : '';
    const source = $('#sourceStatus');
    if (source) {
      const oxford = state.stats.oxford;
      const english = state.stats.mw ? "MW Learner's" : 'Wiktionary';
      const localCount = (state.localDicts.sources || []).length;
      source.innerHTML = `<span class="dot${oxford ? '' : ' off'}"></span>${oxford ? 'Oxford Chinese' : 'Chinese dictionary unavailable'} · ${english}${localCount ? ` · ${localCount} local` : ''}`;
      source.title = oxford
        ? 'Chinese entries come from the Oxford Chinese Dictionary installed in macOS Dictionary.'
        : 'The Oxford Chinese helper was not found. See Settings for details.';
    }
  }

  // ---------------------------------------------------------------- library

  function formatChars(n) {
    if (!n) return '0';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function renderDocs() {
    const docs = state.docs;
    const grid = $('#libraryDocs');
    const empty = $('#libraryEmpty');
    $('#docCount').textContent = docs.length ? plural(docs.length, 'document', 'documents') : '';
    empty.hidden = docs.length > 0;
    grid.hidden = docs.length === 0;

    grid.innerHTML = docs.map((doc) => {
      const progress = Math.round((doc.progress || 0) * 100);
      return `
        <article class="doc-card" data-doc-id="${doc.id}" tabindex="0">
          <button class="delete-doc" data-delete-doc="${doc.id}" title="Remove document" aria-label="Remove document">
            <svg class="ic"><use href="#i-trash"/></svg>
          </button>
          <div class="doc-card-top">
            <span class="doc-format">${esc(doc.format)}</span>
            <span class="doc-card-meta">${formatChars(doc.chars)} characters</span>
          </div>
          <h3>${esc(doc.title)}</h3>
          <div class="doc-card-meta">
            <span>${!doc.last_opened ? 'Not opened yet' : progress ? `${progress}% read` : 'Opened'}</span>
            <span>Added ${(doc.created_at || '').slice(0, 10)}</span>
          </div>
          <div class="doc-card-bar"><i style="width:${progress}%"></i></div>
        </article>`;
    }).join('');

    const recent = $('#recentDocs');
    if (recent) {
      recent.innerHTML = docs.slice(0, 8).map((doc) => `
        <button class="recent-doc${state.doc && state.doc.id === doc.id ? ' active' : ''}" data-doc-id="${doc.id}">
          <span class="doc-format">${esc(doc.format)}</span>
          <span>${esc(doc.title)}</span>
        </button>`).join('');
      if (!docs.length) recent.innerHTML = '<div style="padding:7px 10px;font-size:11px;color:var(--ink-3)">No documents yet.</div>';
    }
  }

  async function openDocument(id, targetParagraph = null) {
    try {
      const data = await api(`/api/documents/${id}`);
      state.doc = data.document;
      state.lookup = null;
      state.lastSelection = '';
      state.lookupContext = '';
      state.highlights = [];
      try {
        const highlights = await api(`/api/documents/${id}/highlights`);
        state.highlights = highlights.highlights || [];
      } catch (error) {
        // A document still opens if highlights fail to load.
      }
      renderReader(targetParagraph);
      showView('reader');
      closeDictionary(true);
    } catch (error) {
      toast(error.message);
    }
  }

  function reportFixes(report) {
    if (!report) return 0;
    return ['joined_lines', 'hyphen_joins', 'merged_paragraphs', 'removed_headers', 'removed_page_numbers']
      .reduce((sum, key) => sum + (Number(report[key]) || 0), 0);
  }

  function showTextCheck(report) {
    if (!report) return;
    const rows = [
      ['Wrapped lines joined', report.joined_lines || 0],
      ['Hyphenated words repaired', report.hyphen_joins || 0],
      ['Paragraphs merged', report.merged_paragraphs || 0],
      ['Running headers removed', report.removed_headers || 0],
      ['Page numbers removed', report.removed_page_numbers || 0]
    ];
    const warnings = report.warnings || [];
    openModal(`
      <div class="modal-head">
        <div><h2>Text check</h2><p>${esc(report.summary || 'Layout check complete.')}</p></div>
        <button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="check-grid">
          ${rows.map(([label, value]) => `<div class="check-row"><span>${esc(label)}</span><strong>${value}</strong></div>`).join('')}
        </div>
        <div class="check-meta">${Number(report.paragraphs || 0).toLocaleString()} paragraphs · ${Number(report.characters || 0).toLocaleString()} characters</div>
        ${warnings.length ? `<div class="check-warnings"><strong>Worth a quick look</strong>${warnings.map((warning) => `<p>${esc(warning)}</p>`).join('')}</div>` : '<div class="check-pass">No obvious structural warnings.</div>'}
        <p class="check-note">The original file is unchanged. This check joins hard-wrapped lines, removes repeated page furniture, and repairs hyphenation; it is heuristic, not OCR.</p>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close>Close</button></div>`);
  }

  function highlightRanges(text, paragraphIndex) {
    const ranges = [];
    for (const highlight of state.highlights || []) {
      if (Number(highlight.paragraph_index) !== paragraphIndex) continue;
      let start = Number(highlight.start_offset);
      let end = Number(highlight.end_offset);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      if (text.slice(start, end) !== highlight.quote) {
        const found = text.indexOf(highlight.quote);
        if (found < 0) continue;
        start = found;
        end = found + highlight.quote.length;
      }
      if (end > text.length) continue;
      ranges.push({ start, end, id: highlight.id });
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start < previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push(range);
      }
    }
    return merged;
  }

  function paragraphHTML(text, paragraphIndex) {
    const ranges = highlightRanges(text, paragraphIndex);
    if (!ranges.length) return esc(text);
    let html = '';
    let cursor = 0;
    for (const range of ranges) {
      html += esc(text.slice(cursor, range.start));
      html += `<mark class="highlight" data-highlight-id="${range.id}">${esc(text.slice(range.start, range.end))}</mark>`;
      cursor = range.end;
    }
    html += esc(text.slice(cursor));
    return html;
  }

  function renderReader(targetParagraph = null) {
    const doc = state.doc;
    if (!doc) return;
    $('#docTitle').textContent = doc.title;
    const progress = Math.round((doc.progress || 0) * 100);
    $('#docMeta').textContent = `${doc.format} · ${formatChars(doc.text.length)} characters${progress ? ` · ${progress}% read` : ''}`;
    let report = doc.report;
    if (typeof report === 'string') {
      try { report = JSON.parse(report); } catch (error) { report = null; }
    }
    state.report = report || null;
    const fixes = reportFixes(state.report);
    const warnings = (state.report && state.report.warnings) || [];
    const checked = !!(state.report && state.report.checked);
    $('#textCheckBtn').hidden = !checked && !fixes && !warnings.length;
    $('#textCheckBtn').textContent = fixes ? `Text check · ${fixes} fix${fixes === 1 ? '' : 'es'}` : (checked ? 'Text check · clean' : 'Text check');
    $('#textCheckBtn').classList.toggle('warn', warnings.length > 0);
    const container = $('#readerText');
    container.innerHTML = '';
    state.paragraphs = [];
    let paragraphIndex = 0;

    const pages = String(doc.text).split(/\n\n<<<PAGE>>>\n\n/);
    pages.forEach((page, pageIndex) => {
      if (pageIndex > 0) {
        const marker = document.createElement('div');
        marker.className = 'page-break';
        marker.textContent = `Page ${pageIndex + 1}`;
        container.appendChild(marker);
      }
      const paragraphs = page.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      paragraphs.forEach((text) => {
        const p = document.createElement('p');
        p.dataset.paragraph = String(paragraphIndex);
        p.innerHTML = paragraphHTML(text, paragraphIndex);
        container.appendChild(p);
        state.paragraphs.push(text);
        paragraphIndex += 1;
      });
    });

    const end = document.createElement('div');
    end.className = 'doc-end';
    end.textContent = 'End of document';
    container.appendChild(end);

    renderDocs();
    renderRecentWords();
    const pane = $('#readerPane');
    restoringScroll = true;
    window.setTimeout(() => {
      if (targetParagraph !== null) {
        const target = container.querySelector(`p[data-paragraph="${targetParagraph}"]`);
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'auto' });
          target.classList.add('highlight-flash');
          window.setTimeout(() => target.classList.remove('highlight-flash'), 1800);
        }
        restoringScroll = false;
      } else {
        const max = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = max * clamp(doc.progress || 0, 0, 1);
        updateReaderProgress();
        window.setTimeout(() => { restoringScroll = false; }, 220);
      }
    }, 120);
  }

  function updateReaderProgress() {
    const pane = $('#readerPane');
    if (!pane) return;
    const max = Math.max(1, pane.scrollHeight - pane.clientHeight);
    const ratio = clamp(pane.scrollTop / max, 0, 1);
    $('#readerProgress').style.width = `${Math.round(ratio * 100)}%`;
    return ratio;
  }

  let saveProgressTimer = null;
  let restoringScroll = false;
  function scheduleSaveProgress() {
    if (restoringScroll) return;
    const ratio = updateReaderProgress();
    if (!state.doc) return;
    state.doc.progress = ratio;
    window.clearTimeout(saveProgressTimer);
    saveProgressTimer = window.setTimeout(() => {
      if (!state.doc) return;
      api(`/api/documents/${state.doc.id}/progress`, {
        method: 'POST',
        body: { progress: ratio }
      }).catch(() => {});
    }, 500);
  }

  // ---------------------------------------------------------------- upload

  function pickFiles() {
    $('#fileInput').click();
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file.size > 0);
    if (!files.length) return;
    const uploadState = $('#uploadState');
    uploadState.hidden = false;
    let lastDoc = null;
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      uploadState.innerHTML = `<span class="spinner"></span> Reading ${esc(file.name)}…`;
      try {
        const data = await api('/api/upload', {
          method: 'POST',
          headers: {
            'X-Filename': encodeURIComponent(file.name),
            'Content-Type': 'application/octet-stream'
          },
          body: file
        });
        lastDoc = data.document;
      } catch (error) {
        toast(`${file.name}: ${error.message}`, 4200);
      }
    }
    uploadState.hidden = true;
    uploadState.innerHTML = '<span class="spinner"></span> Reading document…';
    await loadDocs();
    await loadStats();
    if (lastDoc) {
      openDocument(lastDoc.id);
      const fixes = reportFixes(lastDoc.report);
      const warnings = (lastDoc.report && lastDoc.report.warnings) || [];
      if (fixes) {
        toast(`Document added — text check repaired ${fixes} layout issue${fixes === 1 ? '' : 's'}.${warnings.length ? ' Open Text check to review warnings.' : ''}`, 4200);
      } else {
        toast('Document added. Text check found no layout repairs.');
      }
    }
  }

  // ---------------------------------------------------------------- dictionary lookup

  function sentenceAround(text, word) {
    const lower = text.toLowerCase();
    const index = lower.indexOf(word.toLowerCase());
    if (index < 0) return text.slice(0, 420).trim();
    const before = text.slice(0, index);
    const after = text.slice(index + word.length);
    const startMatch = before.match(/.*[.!?]\s+/s);
    const endMatch = after.match(/^.*?[.!?](?:\s|$)/s);
    const start = startMatch ? startMatch[0].length : 0;
    const end = endMatch ? index + word.length + endMatch[0].length : text.length;
    return text.slice(start, end).trim().slice(0, 520);
  }

  function hideSelectionToolbar() {
    const toolbar = $('#selectionToolbar');
    if (toolbar) toolbar.hidden = true;
  }

  function showSelectionToolbar(rect) {
    const toolbar = $('#selectionToolbar');
    if (!toolbar || !rect) return;
    toolbar.hidden = false;
    const width = toolbar.offsetWidth || 150;
    const left = clamp(rect.left + rect.width / 2, width / 2 + 8, window.innerWidth - width / 2 - 8);
    let top = rect.top - 40;
    if (top < 8) top = rect.bottom + 8;
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function sentenceBounds(text, start, end) {
    const before = text.slice(0, start);
    const starts = [];
    const boundary = /[.!?。！？]["'”’]?(?:\s+|$)/g;
    let match;
    while ((match = boundary.exec(before))) {
      starts.push(match.index + match[0].length);
    }
    let sentenceStart = starts.length ? starts[starts.length - 1] : 0;
    let sentenceEnd = end;
    const endsAtBoundary = /[.!?。！？]["'”’]?\s*$/.test(text.slice(0, end));
    if (!endsAtBoundary) {
      const after = text.slice(end);
      const endMatch = after.match(/[.!?。！？]["'”’]?(?=\s|$)/);
      sentenceEnd = endMatch ? end + endMatch.index + endMatch[0].length : text.length;
    }
    while (sentenceStart < sentenceEnd && /\s/.test(text[sentenceStart])) sentenceStart += 1;
    while (sentenceEnd > sentenceStart && /\s/.test(text[sentenceEnd - 1])) sentenceEnd -= 1;
    if (sentenceEnd - sentenceStart > 4000) {
      return { start, end };
    }
    return { start: sentenceStart, end: sentenceEnd };
  }

  async function saveSelectionHighlight() {
    const selection = state.selection;
    if (!selection || !state.doc) return;
    const bounds = sentenceBounds(selection.paragraphText, selection.start, selection.end);
    const quote = selection.paragraphText.slice(bounds.start, bounds.end);
    if (!quote.trim()) return;
    const button = $('#highlightSelection');
    button.disabled = true;
    try {
      const data = await api(`/api/documents/${state.doc.id}/highlights`, {
        method: 'POST',
        body: {
          paragraph_index: selection.paragraphIndex,
          start_offset: bounds.start,
          end_offset: bounds.end,
          quote
        }
      });
      state.highlights.push(data.highlight);
      state.allHighlights.push(data.highlight);
      hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
      state.selection = null;
      const pane = $('#readerPane');
      const top = pane ? pane.scrollTop : 0;
      renderReader();
      window.setTimeout(() => {
        if (pane) pane.scrollTop = top;
        restoringScroll = false;
      }, 170);
      await loadAllHighlights();
      await loadStats();
      toast('Sentence highlighted.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function captureSelection() {
    if (state.view !== 'reader') {
      hideSelectionToolbar();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideSelectionToolbar();
      return;
    }
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (!anchor || !focus || !$('#readerText').contains(anchor)) {
      hideSelectionToolbar();
      return;
    }
    let paragraph = anchor.nodeType === 3 ? anchor.parentElement : anchor;
    paragraph = paragraph && paragraph.closest ? paragraph.closest('p') : null;
    if (!paragraph || !$('#readerText').contains(paragraph)) {
      hideSelectionToolbar();
      return;
    }
    if (!paragraph.contains(focus)) {
      hideSelectionToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(paragraph);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const raw = sel.toString();
    const end = start + raw.length;
    if (!raw.trim()) {
      hideSelectionToolbar();
      return;
    }
    state.selection = {
      paragraphIndex: Number(paragraph.dataset.paragraph),
      start,
      end,
      paragraphText: paragraph.textContent
    };
    showSelectionToolbar(range.getBoundingClientRect());

    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean.length > 70) return;
    const word = clean.replace(/^[^A-Za-z\u3400-\u9fff']+|[^A-Za-z\u3400-\u9fff']+$/g, '');
    if (!word || word.split(/\s+/).length > 4) return;
    if (!/[A-Za-z\u3400-\u9fff]/.test(word)) return;
    const context = sentenceAround(paragraph.textContent, word);
    const signature = `${word.toLowerCase()}|${context}`;
    if (signature === state.lastSelection) return;
    state.lastSelection = signature;
    lookupWord(word, context);
  }

  async function lookupWord(word, context = '') {
    const seq = ++state.lookupSeq;
    state.lookup = null;
    state.lookupContext = context;
    $('#dictEmpty').hidden = true;
    $('#dictContent').hidden = true;
    $('#dictLoading').hidden = false;
    $('#lookupWord').textContent = word;
    document.body.classList.add('dict-open');

    try {
      const data = await api('/api/lookup', { method: 'POST', body: { word } });
      if (seq !== state.lookupSeq) return;
      state.lookup = data;
      renderLookup();
    } catch (error) {
      if (seq !== state.lookupSeq) return;
      renderLookupError(word, error.message);
    }
  }

  let lookupSources = [];
  let lookupTab = 0;

  function cleanPhonetic(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function localPhonetic(local) {
    const ordered = [...(local || [])].sort((a, b) => (a.language === 'en-zh' ? -1 : 1) - (b.language === 'en-zh' ? -1 : 1));
    for (const source of ordered) {
      for (const entry of source.entries || []) {
        for (const card of (Array.isArray(entry.data) ? entry.data : [])) {
          if (card.phonetic) return card.phonetic;
        }
      }
    }
    return '';
  }

  function shortSourceLabel(name) {
    if (/collins/i.test(name)) return 'Collins';
    if (/oxford/i.test(name)) return 'Oxford';
    return String(name || 'Dictionary').split(/[:(]/)[0].trim().slice(0, 22);
  }

  function localSenseHTML(sense, index) {
    const examples = (sense.examples || []).slice(0, 3).map((example) => `
      <div class="sense-ex">
        <span class="ex-en">${esc(example.text)}</span>
        ${example.zh ? `<span class="ex-zh">${esc(example.zh)}</span>` : ''}
      </div>`).join('');
    const synonyms = (sense.synonyms || []).length
      ? `<div class="syn-line"><span>Similar</span>${sense.synonyms.slice(0, 8).map((word) => `<em>${esc(word)}</em>`).join('')}</div>`
      : '';
    return `
      <div class="sense-row${index >= 3 ? ' extra-sense' : ''}">
        <span class="sense-num">${index + 1}</span>
        <div class="sense-body">
          <div class="sense-def">${esc(sense.def)}</div>
          ${sense.zh ? `<div class="sense-zh">${esc(sense.zh)}</div>` : ''}
          ${examples}
          ${synonyms}
        </div>
      </div>`;
  }

  function localEntryHTML(entry, word) {
    const cards = Array.isArray(entry.data) ? entry.data : [];
    if (!cards.length) {
      return `<div class="local-raw-card"><div class="local-raw-text">${esc(entry.text || '')}</div></div>`;
    }
    return cards.map((card) => {
      const senses = card.senses || [];
      const senseHTML = senses.map((sense, index) => localSenseHTML(sense, index)).join('');
      const hidden = senses.length > 3;
      return `
        <article class="local-entry-card">
          <header class="local-entry-head">
            <div class="local-entry-title">
              <span class="local-headword">${esc(card.headword || entry.headword || word)}</span>
            </div>
            ${card.pos ? `<span class="pos-badge">${esc(card.pos)}</span>` : ''}
          </header>
          <div class="sense-list">${senseHTML}</div>
          ${hidden ? `<button class="show-senses" data-show-senses>Show all ${senses.length} senses</button>` : ''}
        </article>`;
    }).join('');
  }

  function localSourceHTML(source, word) {
    const entries = source.entries || [];
    if (!entries.length) return '<div class="lookup-empty">No entry in this dictionary.</div>';
    return entries.map((entry) => localEntryHTML(entry, word)).join('');
  }

  function renderLookupTabs() {
    const tabs = $('#lookupTabs');
    if (!tabs) return;
    if (lookupSources.length <= 1) {
      tabs.innerHTML = '';
      tabs.hidden = true;
      return;
    }
    tabs.hidden = false;
    tabs.innerHTML = lookupSources.map((source, index) => `
      <button class="lookup-tab${index === lookupTab ? ' active' : ''}" data-lookup-tab="${index}" role="tab" aria-selected="${index === lookupTab}">
        <span>${esc(source.label)}</span><small>${esc(source.badge)}</small>
      </button>`).join('');
    tabs.querySelectorAll('[data-lookup-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        lookupTab = Number(button.dataset.lookupTab);
        renderLookupTabs();
        renderLookupPane();
      });
    });
  }

  function renderLookupPane() {
    const pane = $('#lookupPane');
    const source = lookupSources[lookupTab];
    if (!pane || !source) return;
    if (source.kind === 'local') {
      pane.innerHTML = localSourceHTML(source.source, state.lookup.word);
    } else if (source.kind === 'online') {
      pane.innerHTML = englishHTML(source.source);
    } else {
      pane.innerHTML = chineseHTML(source.source, state.lookup.word);
    }
    pane.querySelectorAll('[data-show-senses]').forEach((button) => {
      button.addEventListener('click', () => {
        const card = button.closest('.local-entry-card');
        card.querySelectorAll('.extra-sense').forEach((row) => row.classList.remove('extra-sense'));
        button.remove();
      });
    });
  }

  function renderLookup() {
    const data = state.lookup;
    if (!data) return;
    $('#dictLoading').hidden = true;
    $('#dictEmpty').hidden = true;
    $('#dictContent').hidden = false;
    $('#lookupWord').textContent = data.word;

    const local = data.local || [];
    const phonetic = cleanPhonetic(data.phonetic || localPhonetic(local));
    $('#lookupPhonetic').textContent = phonetic;
    $('#speakBtn').hidden = !phonetic;

    const savedNote = $('#savedNote');
    const addBtn = $('#addWordBtn');
    addBtn.disabled = !!data.saved;
    addBtn.innerHTML = data.saved
      ? '<svg class="ic"><use href="#i-check"/></svg> In notebook'
      : '<svg class="ic"><use href="#i-plus"/></svg> Add to notebook';
    savedNote.textContent = data.saved
      ? 'Already saved'
      : (state.lookupContext ? 'The sentence will be saved too' : '');
    savedNote.className = `saved-note${data.saved ? '' : ' warn'}`;

    lookupSources = [];
    for (const source of local) {
      lookupSources.push({
        kind: 'local',
        label: shortSourceLabel(source.name),
        badge: 'LOCAL',
        source
      });
    }
    if (data.english) {
      lookupSources.push({
        kind: 'online',
        label: /merriam/i.test(data.english.name) ? 'Merriam-Webster' : 'Wiktionary',
        badge: 'WEB',
        source: data.english
      });
    }
    if (data.chinese) {
      lookupSources.push({ kind: 'mac', label: '中文', badge: 'macOS', source: data.chinese });
    }
    lookupTab = 0;
    renderLookupTabs();
    renderLookupPane();

    const notes = [];
    if (data.lemma && data.lemma.toLowerCase() !== data.word.toLowerCase()) {
      notes.push(`Base form: ${data.lemma}`);
    }
    if (data.english) notes.push(data.english.cached ? 'English entry cached locally.' : 'English from Wiktionary / Merriam-Webster.');
    if (data.chinese) notes.push('Chinese from the Oxford Chinese Dictionary installed in macOS.');
    $('#dictSourceNote').textContent = notes.join(' ');
    $('#dictSourceNote').hidden = !notes.length;
    document.body.classList.add('dict-open');
  }

  function renderLookupError(word, message) {
    state.lastSelection = '';
    $('#dictLoading').hidden = true;
    $('#dictEmpty').hidden = true;
    $('#dictContent').hidden = false;
    $('#lookupWord').textContent = word;
    $('#lookupPhonetic').textContent = '';
    $('#speakBtn').hidden = true;
    $('#lookupTabs').hidden = true;
    $('#lookupTabs').innerHTML = '';
    $('#lookupPane').innerHTML = `<div class="lookup-empty">${esc(message)}</div>`;
    $('#dictSourceNote').textContent = 'Try selecting the base form, or check the spelling.';
    $('#dictSourceNote').hidden = false;
    $('#addWordBtn').disabled = true;
    $('#savedNote').textContent = '';
  }

  function englishHTML(source) {
    if (!source || !source.entries || !source.entries.length) {
      return `<div class="lookup-empty">No English definition found. The word may be inflected, a proper noun, or missing from the open dictionary.</div>`;
    }
    const link = source.url
      ? `<a class="source-link" href="${esc(source.url)}" target="_blank" rel="noopener">Open <svg class="ic"><use href="#i-external"/></svg></a>`
      : '';
    const entries = source.entries.slice(0, 4).map((entry) => {
      const defs = (entry.defs || []).slice(0, 4).map((def, index) => `
        <div class="sense-def">${index ? `<span class="num">${index + 1}.</span>` : ''}${esc(def.def)}</div>
        ${def.example ? `<div class="sense-ex">${esc(def.example)}</div>` : ''}
      `).join('');
      const syn = (entry.synonyms || []).length
        ? `<div class="syn-line"><span>Similar</span>${entry.synonyms.slice(0, 6).map((s) => `<em>${esc(s)}</em>`).join('')}</div>`
        : '';
      return `<div class="sense">${entry.pos ? `<div class="sense-pos">${esc(entry.pos)}</div>` : ''}${defs}${syn}</div>`;
    }).join('');
    return `
      <div class="source-block">
        <div class="source-head">
          <span class="source-name">${esc(source.name)}${source.detail ? `<span class="tag">· ${esc(source.detail)}</span>` : ''}</span>
          ${link}
        </div>
        ${entries}
      </div>`;
  }

  function chineseHTML(source, word) {
    if (!source || !source.entries || !source.entries.length) {
      return `<div class="lookup-empty">No Chinese entry found. Make sure the Oxford Chinese Dictionary is installed in Dictionary.app.</div>`;
    }
    const entry = source.entries[0];
    const text = entry.text || '';
    const long = text.length > 520;
    return `
      <div class="source-block">
        <div class="source-head">
          <span class="source-name">中文 · ${esc(entry.name || 'Oxford Chinese Dictionary')}</span>
          <a class="source-link" href="dict://${encodeURIComponent(word)}">Dictionary <svg class="ic"><use href="#i-external"/></svg></a>
        </div>
        <div class="oxford-entry${long ? '' : ' expanded'}">${formatOxford(text, word)}</div>
        ${long ? '<button class="oxford-toggle" data-oxford>Show full entry</button>' : ''}
      </div>`;
  }

  function formatOxford(text, word) {
    const safe = esc(text);
    const parts = safe.split(/\s*\|\s*/);
    const blocks = [];
    parts.forEach((part, partIndex) => {
      if (partIndex === 0 && part.trim().toLowerCase() === word.toLowerCase()) return;
      const chunks = part.split('▸');
      chunks.forEach((chunk, chunkIndex) => {
        const clean = chunk.trim();
        if (!clean) return;
        if (chunkIndex === 0 && partIndex <= 1) {
          blocks.push(`<div class="ox-line ox-head">${clean}</div>`);
        } else if (chunkIndex > 0) {
          blocks.push(`<div class="ox-line ox-ex">${clean}</div>`);
        } else {
          blocks.push(`<div class="ox-line">${clean}</div>`);
        }
      });
    });
    return blocks.join('') || safe;
  }

  async function addCurrentWord() {
    const data = state.lookup;
    if (!data || data.saved) return;
    const chinese = data.chinese
      ? data.chinese.entries.map((entry) => entry.text).join('\n\n')
      : '';
    const english = [];
    if (data.english) english.push(data.english);
    for (const source of (data.local || [])) {
      const defs = [];
      for (const entry of source.entries || []) {
        const cards = Array.isArray(entry.data) ? entry.data : [];
        if (!cards.length && entry.text) {
          defs.push({ def: String(entry.text).slice(0, 2000), example: '' });
          continue;
        }
        for (const card of cards) {
          for (const sense of (card.senses || [])) {
            if (!sense.def) continue;
            defs.push({
              def: sense.zh ? `${sense.def} — ${sense.zh}` : sense.def,
              example: (sense.examples || [])[0]?.text || ''
            });
            if (defs.length >= 8) break;
          }
          if (defs.length >= 8) break;
        }
        if (defs.length >= 8) break;
      }
      english.push({
        name: source.name,
        detail: 'local MDX',
        entries: [{ pos: '', defs, synonyms: [] }]
      });
    }
    try {
      const result = await api('/api/notebook', {
        method: 'POST',
        body: {
          word: data.word,
          lemma: data.lemma || data.word,
          phonetic: data.phonetic || localPhonetic(data.local),
          english,
          chinese,
          context: state.lookupContext || '',
          document_id: state.doc ? state.doc.id : null
        }
      });
      data.saved = true;
      $('#addWordBtn').disabled = true;
      $('#addWordBtn').innerHTML = '<svg class="ic"><use href="#i-check"/></svg> In notebook';
      $('#savedNote').textContent = result.existing ? 'Already saved' : 'Saved';
      await Promise.all([loadNotebook(), loadStats()]);
      toast(result.existing ? 'Already in your notebook.' : 'Added to notebook.');
    } catch (error) {
      toast(error.message);
    }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) {
      toast('This browser has no speech voice.');
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US';
      utterance.rate = 0.9;
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find((v) => /en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      toast('Could not play the pronunciation.');
    }
  }

  function closeDictionary(reset = false) {
    document.body.classList.remove('dict-open');
    if (reset) {
      $('#dictContent').hidden = true;
      $('#dictEmpty').hidden = false;
      $('#dictLoading').hidden = true;
      state.lookup = null;
      state.lastSelection = '';
    }
    try { window.getSelection().removeAllRanges(); } catch (error) { /* ignore */ }
    state.lastSelection = '';
  }

  function renderRecentWords() {
    const root = $('#recentWords');
    if (!root) return;
    const words = state.notebook.slice(0, 8);
    root.innerHTML = words.map((entry) => `<button class="recent-word" data-recent="${esc(entry.word)}">${esc(entry.word)}</button>`).join('');
  }

  // ---------------------------------------------------------------- notebook

  function renderNotebook() {
    const list = $('#notebookList');
    const empty = $('#notebookEmpty');
    const entries = state.notebook;
    const due = entries.filter((entry) => entry.due).length;
    $('#notebookSub').textContent = entries.length
      ? `${plural(entries.length, 'word', 'words')} · ${due} due for review`
      : 'Words saved from your reading, with their original context.';
    $('#startReviewBtn').disabled = due === 0;
    $('#startReviewBtn').title = due ? 'Review words that are due' : 'Nothing is due right now';
    empty.hidden = entries.length > 0;
    list.hidden = entries.length === 0;

    list.innerHTML = entries.map((entry) => {
      const status = entry.known ? 'known' : entry.due ? 'due' : 'scheduled';
      const statusLabel = entry.known ? 'Known' : entry.due ? 'Due' : (entry.srs && entry.srs.state === 'learning' ? 'Learning' : 'Scheduled');
      const dueText = entry.known ? '—' : entry.due ? 'review now' : `in ${formatDelay((entry.next_due || 0) - Date.now())}`;
      const chinese = (entry.chinese || '').replace(/\s+/g, ' ').slice(0, 70);
      return `
        <button class="nb-row" data-nb-id="${entry.id}">
          <span class="nb-word">${esc(entry.word)}<small>${esc(entry.phonetic || '')}</small></span>
          <span class="nb-def">${esc(entry.primary_def || 'No English definition')}${chinese ? `<small>${esc(chinese)}</small>` : ''}</span>
          <span class="nb-status ${status}">${statusLabel}</span>
          <span class="nb-due">${dueText}</span>
        </button>`;
    }).join('');
  }

  function openNotebookModal(id) {
    const entry = state.notebook.find((item) => item.id === Number(id));
    if (!entry) return;
    const accuracy = entry.stats && entry.stats.seen
      ? `${Math.round((entry.stats.correct / entry.stats.seen) * 100)}%`
      : '—';
    const next = entry.known ? 'Known' : entry.due ? 'Due now' : `in ${formatDelay((entry.next_due || 0) - Date.now())}`;
    const english = englishHTML((entry.english || [])[0]);
    const chinese = entry.chinese
      ? `<div class="source-block"><div class="source-head"><span class="source-name">中文 · Oxford Chinese Dictionary</span></div>
         <div class="oxford-entry expanded">${formatOxford(entry.chinese, entry.word)}</div></div>`
      : '';
    const wrap = openModal(`
      <div class="modal-head">
        <div class="nb-detail-head">
          <div>
            <h2>${esc(entry.word)}</h2>
            <p class="lookup-phonetic">${esc(entry.phonetic || '')}</p>
          </div>
        </div>
        <button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body">
        ${entry.context ? `<p class="nb-detail-context">${esc(entry.context)}</p>` : ''}
        ${english}
        ${chinese}
        <div class="nb-detail-stats">
          <div><strong>${entry.stats.seen || 0}</strong><span>Reviews</span></div>
          <div><strong>${accuracy}</strong><span>Recall</span></div>
          <div><strong>${entry.interval ? entry.interval + 'd' : '—'}</strong><span>Interval</span></div>
          <div><strong>${next}</strong><span>Next</span></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-nb-action="delete">Delete</button>
        <button class="btn btn-outline" data-nb-action="known">${entry.known ? 'Bring back' : 'Mark known'}</button>
        <button class="btn btn-primary" data-nb-action="review">Review now</button>
        <button class="btn btn-ghost" data-close>Done</button>
      </div>
    `);

    wrap.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-nb-action]');
      if (!btn) return;
      const action = btn.dataset.nbAction;
      if (action === 'review') {
        closeModal();
        startReview([entry]);
      } else if (action === 'known') {
        api(`/api/notebook/${entry.id}`, { method: 'POST', body: { known: !entry.known } })
          .then(() => {
            closeModal();
            loadNotebook();
            loadStats();
            toast(entry.known ? 'Back in rotation.' : 'Moved to known words.');
          })
          .catch((error) => toast(error.message));
      } else if (action === 'delete') {
        closeModal();
        confirmDialog({
          title: `Delete “${entry.word}”?`,
          message: 'This removes the word and its review history from your notebook.',
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => {
            api(`/api/notebook/${entry.id}`, { method: 'DELETE' })
              .then(() => {
                loadNotebook();
                loadStats();
                toast('Word deleted.');
              })
              .catch((error) => toast(error.message));
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------- review

  function blankSrs() {
    return { state: 'new', step: 0, ease: 2.5, interval: 0, due: Date.now(), reps: 0, lapses: 0 };
  }

  function schedulePreview(srsIn, grade) {
    const now = Date.now();
    const srs = { ...blankSrs(), ...(srsIn || {}) };
    srs.reps = (srs.reps || 0) + 1;
    if (srs.state === 'new') {
      srs.state = 'learning';
      srs.step = 0;
      srs.ease = 2.5;
      srs.interval = 0;
    }
    if (srs.state === 'learning') {
      if (grade === 1) srs.due = now + MINUTE;
      else if (grade === 2) srs.due = now + (srs.step === 0 ? 6 : 10) * MINUTE;
      else if (grade === 3) {
        if (srs.step >= 1) { srs.state = 'review'; srs.interval = 1; srs.due = now + DAY; }
        else { srs.step = 1; srs.due = now + 10 * MINUTE; }
      } else { srs.state = 'review'; srs.interval = 4; srs.due = now + 4 * DAY; }
      return srs;
    }
    if (srs.state === 'relearning') {
      if (grade === 1) srs.due = now + 10 * MINUTE;
      else if (grade === 2) srs.due = now + 15 * MINUTE;
      else if (grade === 3) { srs.state = 'review'; srs.interval = 1; srs.due = now + DAY; }
      else { srs.state = 'review'; srs.interval = 3; srs.due = now + 3 * DAY; }
      return srs;
    }
    if (grade === 1) {
      srs.state = 'relearning';
      srs.due = now + 10 * MINUTE;
      return srs;
    }
    const interval = Math.max(1, srs.interval || 1);
    const ease = srs.ease || 2.5;
    srs.state = 'review';
    if (grade === 2) srs.interval = Math.max(interval + 1, Math.round(interval * 1.2));
    else if (grade === 3) srs.interval = Math.max(1, Math.round(interval * ease));
    else srs.interval = Math.max(interval + 1, Math.round(interval * ease * 1.3));
    srs.due = now + srs.interval * DAY;
    return srs;
  }

  function formatDelay(ms) {
    if (ms <= 0) return 'now';
    if (ms < MINUTE) return '<1m';
    if (ms < 60 * MINUTE) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
    if (ms < DAY) return `${Math.round(ms / (60 * MINUTE))}h`;
    if (ms < 30 * DAY) return `${Math.round(ms / DAY)}d`;
    if (ms < 365 * DAY) return `${Math.round(ms / (30 * DAY))}mo`;
    return `${(ms / (365 * DAY)).toFixed(1).replace(/\.0$/, '')}y`;
  }

  async function startReview(preloaded) {
    let queue = preloaded;
    if (!queue) {
      try {
        const data = await api('/api/review');
        queue = data.queue || [];
      } catch (error) {
        toast(error.message);
        return;
      }
    }
    if (!queue.length) {
      toast('Nothing is due right now. Add more words or come back later.');
      return;
    }
    state.review = {
      queue,
      index: 0,
      reviewed: 0,
      correct: 0,
      started: Date.now(),
      answered: false,
      total: queue.length
    };
    $('#reviewOverlay').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#reviewCard').hidden = false;
    $('#reviewSummary').hidden = true;
    $('#reviewGrades').hidden = true;
    renderReview();
    startReviewTimer();
  }

  function startReviewTimer() {
    window.clearInterval(state.timer);
    updateReviewTimer();
    state.timer = window.setInterval(updateReviewTimer, 1000);
  }

  function updateReviewTimer() {
    if (!state.review) return;
    const seconds = Math.max(0, Math.round((Date.now() - state.review.started) / 1000));
    $('#reviewTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderReview() {
    const review = state.review;
    if (!review) return;
    if (review.index >= review.queue.length) {
      renderReviewSummary();
      return;
    }
    const entry = review.queue[review.index];
    review.answered = false;
    $('#reviewCard').classList.remove('answered');
    $('#reviewAnswer').hidden = true;
    $('#reviewGrades').hidden = true;
    $('#reviewLabel').textContent = entry.srs && entry.srs.state === 'new' ? 'New word' : 'Review';
    $('#reviewWord').textContent = entry.word;
    $('#reviewPhonetic').textContent = entry.phonetic || '';
    $('#reviewContext').innerHTML = entry.context ? highlightContext(entry.context, entry.word) : '';
    $('#reviewCount').textContent = `${review.index + 1} / ${review.queue.length}`;
    $('#reviewBar').style.width = `${Math.round((review.index / Math.max(1, review.queue.length)) * 100)}%`;
    $('#reviewAccuracy').textContent = review.reviewed
      ? `${Math.round((review.correct / review.reviewed) * 100)}% recall`
      : '';
    $$('#reviewGrades .grade small').forEach((el, i) => {
      el.textContent = formatDelay(schedulePreview(entry.srs, i + 1).due - Date.now());
    });
  }

  function highlightContext(text, word) {
    const safe = esc(text);
    const escaped = esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return safe.replace(new RegExp(`\\b${escaped}\\w*`, 'gi'), (match) => `<b>${match}</b>`);
    } catch (error) {
      return safe;
    }
  }

  function revealReview() {
    const review = state.review;
    if (!review || review.index >= review.queue.length) return;
    const entry = review.queue[review.index];
    review.answered = true;
    $('#reviewCard').classList.add('answered');
    const english = (entry.english || [])[0];
    const chinese = (entry.chinese || '').slice(0, 700);
    $('#reviewAnswer').innerHTML = `
      ${english && english.entries ? english.entries.slice(0, 2).map((group) => `
        <div class="sense">
          ${group.pos ? `<div class="sense-pos">${esc(group.pos)}</div>` : ''}
          ${(group.defs || []).slice(0, 3).map((def) => `<div class="sense-def">${esc(def.def)}</div>`).join('')}
        </div>`).join('') : '<div class="lookup-empty">No English definition.</div>'}
      ${chinese ? `<div class="source-block"><div class="source-head"><span class="source-name">中文 · Oxford</span></div><div class="oxford-entry expanded" style="max-height:150px;overflow:auto">${formatOxford(chinese, entry.word)}</div></div>` : ''}
    `;
    $('#reviewAnswer').hidden = false;
    $('#reviewGrades').hidden = false;
  }

  async function gradeReview(grade) {
    const review = state.review;
    if (!review || !review.answered) return;
    const entry = review.queue[review.index];
    try {
      const data = await api(`/api/notebook/${entry.id}/review`, { method: 'POST', body: { grade } });
      entry.srs = data.srs;
      review.reviewed += 1;
      if (grade >= 2) review.correct += 1;
      if ((data.srs.due || 0) - Date.now() <= 20 * MINUTE) {
        review.queue.push(entry);
      }
      review.index += 1;
      renderReview();
    } catch (error) {
      toast(error.message);
    }
  }

  function renderReviewSummary() {
    const review = state.review;
    window.clearInterval(state.timer);
    $('#reviewCard').hidden = true;
    $('#reviewGrades').hidden = true;
    $('#reviewSummary').hidden = false;
    const seconds = Math.max(0, Math.round((Date.now() - review.started) / 1000));
    const accuracy = review.reviewed ? Math.round((review.correct / review.reviewed) * 100) : 0;
    $('#reviewSummary').innerHTML = `
      <p class="eyebrow">Session complete</p>
      <h2>${accuracy >= 90 ? 'Sharp recall.' : accuracy >= 75 ? 'Solid session.' : 'Good work showing up.'}</h2>
      <p class="sub">${plural(review.reviewed, 'review', 'reviews')} · ${plural(Math.round(seconds / 60), 'minute', 'minutes')}</p>
      <div class="summary-grid">
        <div><strong>${review.reviewed}</strong><span>Reviewed</span></div>
        <div><strong>${accuracy}%</strong><span>Recall</span></div>
        <div><strong>${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}</strong><span>Time</span></div>
      </div>
      <div class="summary-actions">
        <button class="btn btn-primary" data-review-done>Back to notebook</button>
        <button class="btn btn-outline" data-review-more>Review more</button>
      </div>`;
    $('#reviewBar').style.width = '100%';
    $('#reviewCount').textContent = 'Complete';
    $('#reviewAccuracy').textContent = `${accuracy}% recall`;
    $('#reviewSummary').querySelector('[data-review-done]').addEventListener('click', closeReview);
    $('#reviewSummary').querySelector('[data-review-more]').addEventListener('click', () => {
      closeReview();
      startReview();
    });
  }

  function closeReview() {
    $('#reviewOverlay').hidden = true;
    document.body.style.overflow = '';
    window.clearInterval(state.timer);
    state.review = null;
    $('#reviewCard').hidden = false;
    loadNotebook();
    loadStats();
    showView('notebook');
  }

  // ---------------------------------------------------------------- modal

  let modalOpen = false;

  function openModal(html, options = {}) {
    closeModal();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal${options.wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    $('#modalRoot').appendChild(wrap);
    modalOpen = true;
    wrap.addEventListener('mousedown', (event) => {
      if (event.target === wrap) closeModal();
    });
    wrap.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) closeModal();
    });
    const focusable = wrap.querySelector('input, button, textarea');
    if (focusable) window.setTimeout(() => focusable.focus(), 30);
    return wrap;
  }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
    modalOpen = false;
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
    const wrap = openModal(`
      <div class="modal-head">
        <div><h2>${esc(title)}</h2><p>${esc(message)}</p></div>
        <button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-outline' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>
      </div>`);
    wrap.querySelector('[data-confirm]').addEventListener('click', () => {
      closeModal();
      onConfirm();
    });
  }

  async function openSettings() {
    await loadLocalDicts();
    const s = state.settings;
    const wrap = openModal(`
      <div class="modal-head">
        <div><h2>Settings</h2><p>Dictionary sources, reading comfort, and your data.</p></div>
        <button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="settings-section">
          <div class="settings-label">English dictionary</div>
          <div class="field">
            <label for="mwKey">Merriam-Webster API key</label>
            <input id="mwKey" type="text" value="${esc(s.mw_key || '')}" placeholder="Paste a free Learner's API key" autocomplete="off" spellcheck="false">
            <span class="hint">Without a key, English definitions come from Wiktionary. A free key from <a class="link" href="https://dictionaryapi.com/" target="_blank" rel="noopener">dictionaryapi.com</a> makes them authoritative. The key is stored only in your local database.</span>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Chinese dictionary</div>
          <div class="settings-hint">
            ${state.stats.oxford
              ? 'Oxford Chinese Dictionary detected in macOS Dictionary. Lookups work offline.'
              : 'The Oxford Chinese Dictionary was not found. Install it in Dictionary.app, then reopen Marginalia.'}
          </div>
        </div>
        ${localDictSettingsHTML()}
        <div class="settings-section">
          <div class="settings-label">Reading size</div>
          <div class="seg" id="fontSeg">
            ${[16, 17, 18, 19, 20, 22].map((n) => `<button data-font="${n}" class="${s.font_size === n ? 'on' : ''}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Theme</div>
          <div class="seg" id="themeSeg">
            <button data-theme="auto" class="${s.theme === 'auto' ? 'on' : ''}">System</button>
            <button data-theme="light" class="${s.theme === 'light' ? 'on' : ''}">Light</button>
            <button data-theme="dark" class="${s.theme === 'dark' ? 'on' : ''}">Dark</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Notebook</div>
          <div class="settings-row">
            <span class="settings-hint">Export a JSON copy of your words, definitions, context, and review schedule.</span>
            <a class="btn btn-outline btn-sm" href="/api/export"><svg class="ic"><use href="#i-download"/></svg> Export</a>
          </div>
        </div>
        <div class="settings-section">
          <p class="settings-hint">Your documents and notebook live in <code>reader/data/reader.db</code> on this Mac. Nothing is uploaded to a server.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save-settings>Save settings</button>
      </div>
    `);

    wrap.querySelector('#fontSeg').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-font]');
      if (!btn) return;
      state.settings.font_size = Number(btn.dataset.font);
      applyFont();
      $$('#fontSeg button').forEach((b) => b.classList.toggle('on', b === btn));
    });
    wrap.querySelector('#themeSeg').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-theme]');
      if (!btn) return;
      state.settings.theme = btn.dataset.theme;
      applyTheme();
      $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b === btn));
    });
    const openDictBtn = wrap.querySelector('[data-open-dict]');
    if (openDictBtn) {
      openDictBtn.addEventListener('click', async () => {
        try {
          await api('/api/local-dictionaries/open', { method: 'POST', body: {} });
        } catch (error) {
          toast(error.message);
        }
      });
    }
    const indexDictBtn = wrap.querySelector('[data-index-dict]');
    if (indexDictBtn) {
      indexDictBtn.addEventListener('click', async () => {
        indexDictBtn.disabled = true;
        indexDictBtn.textContent = 'Indexing…';
        try {
          const result = await api('/api/local-dictionaries/index', { method: 'POST', body: {} });
          const ok = (result.results || []).filter((item) => !item.error && !item.skipped);
          const failed = (result.results || []).filter((item) => item.error);
          if (failed.length) toast(failed[0].error, 4200);
          await loadLocalDicts();
          closeModal();
          await openSettings();
          toast(ok.length ? `Indexed ${ok.length} ${ok.length === 1 ? 'dictionary' : 'dictionaries'}.` : 'Dictionary index is up to date.');
        } catch (error) {
          toast(error.message);
          indexDictBtn.disabled = false;
          indexDictBtn.textContent = 'Index dictionaries';
        }
      });
    }

    wrap.querySelector('[data-save-settings]').addEventListener('click', async () => {
      const mwKey = wrap.querySelector('#mwKey').value.trim();
      const ok = await saveSettings({
        mw_key: mwKey,
        font_size: state.settings.font_size,
        theme: state.settings.theme
      });
      if (!ok) return;
      closeModal();
      loadStats();
      toast('Settings saved.');
    });
  }

  // ---------------------------------------------------------------- views

  function openHighlightDialog(id) {
    const highlight = (state.allHighlights || []).find((item) => Number(item.id) === Number(id))
      || (state.highlights || []).find((item) => Number(item.id) === Number(id));
    if (!highlight) return;
    const wrap = openModal(`
      <div class="modal-head">
        <div><h2>Highlight</h2><p>${esc(highlight.document_title || state.doc?.title || '')}</p></div>
        <button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body">
        <blockquote class="highlight-quote">${esc(highlight.quote)}</blockquote>
        <div class="check-meta">Saved ${esc((highlight.created_at || '').slice(0, 10))}</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Close</button>
        <button class="btn btn-outline" data-remove-highlight>Remove highlight</button>
      </div>`);
    wrap.querySelector('[data-remove-highlight]').addEventListener('click', async () => {
      try {
        await api(`/api/highlights/${highlight.id}`, { method: 'DELETE' });
        state.highlights = state.highlights.filter((item) => Number(item.id) !== Number(highlight.id));
        state.allHighlights = state.allHighlights.filter((item) => Number(item.id) !== Number(highlight.id));
        closeModal();
        const pane = $('#readerPane');
        const top = pane ? pane.scrollTop : 0;
        renderReader();
        window.setTimeout(() => {
          if (pane) pane.scrollTop = top;
          restoringScroll = false;
        }, 170);
        await loadAllHighlights();
        await loadStats();
        toast('Highlight removed.');
      } catch (error) {
        toast(error.message);
      }
    });
  }

  function renderExcerpts() {
    const list = $('#excerptsList');
    const empty = $('#excerptsEmpty');
    if (!list || !empty) return;
    const all = state.allHighlights || [];
    const query = (state.excerptQuery || '').toLowerCase();
    const filter = state.excerptDoc || '';
    const filtered = all.filter((highlight) => {
      if (filter && String(highlight.document_id) !== String(filter)) return false;
      if (!query) return true;
      return `${highlight.quote || ''} ${highlight.document_title || ''}`.toLowerCase().includes(query);
    });

    const select = $('#excerptDocFilter');
    if (select) {
      const docs = new Map();
      all.forEach((highlight) => docs.set(String(highlight.document_id), highlight.document_title || 'Untitled'));
      select.innerHTML = '<option value="">All books</option>' + [...docs.entries()]
        .map(([id, title]) => `<option value="${esc(id)}">${esc(title)}</option>`).join('');
      select.value = filter;
    }

    if (!filtered.length) {
      list.innerHTML = '';
      list.hidden = true;
      empty.hidden = false;
      $('#excerptTotal').textContent = all.length ? `0 of ${all.length} highlights` : '';
      return;
    }
    list.hidden = false;
    empty.hidden = true;

    const groups = new Map();
    for (const highlight of filtered) {
      const key = String(highlight.document_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(highlight);
    }
    $('#excerptTotal').textContent = `${filtered.length} highlight${filtered.length === 1 ? '' : 's'} · ${groups.size} book${groups.size === 1 ? '' : 's'}`;
    list.innerHTML = [...groups.entries()].map(([docId, highlights]) => {
      const title = highlights[0].document_title || 'Untitled';
      const items = highlights.map((highlight) => `
        <article class="excerpt-item">
          <button class="excerpt-delete" data-delete-highlight="${highlight.id}" title="Remove highlight" aria-label="Remove highlight">
            <svg class="ic"><use href="#i-trash"/></svg>
          </button>
          <blockquote>${esc(highlight.quote)}</blockquote>
          <footer>
            <button class="excerpt-open" data-open-excerpt="${docId}" data-paragraph="${highlight.paragraph_index}">Open in book</button>
            <span>${esc((highlight.created_at || '').slice(0, 10))}</span>
          </footer>
        </article>`).join('');
      return `
        <section class="excerpt-book">
          <header class="excerpt-book-head">
            <button data-open-excerpt="${docId}" data-paragraph="${highlights[0].paragraph_index}">${esc(title)}</button>
            <span>${highlights.length} highlight${highlights.length === 1 ? '' : 's'}</span>
          </header>
          ${items}
        </section>`;
    }).join('');

    list.querySelectorAll('[data-open-excerpt]').forEach((button) => {
      button.addEventListener('click', () => {
        openDocument(Number(button.dataset.openExcerpt), Number(button.dataset.paragraph));
      });
    });
    list.querySelectorAll('[data-delete-highlight]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await api(`/api/highlights/${button.dataset.deleteHighlight}`, { method: 'DELETE' });
          state.allHighlights = state.allHighlights.filter((item) => String(item.id) !== String(button.dataset.deleteHighlight));
          state.highlights = state.highlights.filter((item) => String(item.id) !== String(button.dataset.deleteHighlight));
          renderExcerpts();
          await loadStats();
          toast('Highlight removed.');
        } catch (error) {
          toast(error.message);
        }
      });
    });
  }

  function showView(name) {
    state.view = name;
    const views = { library: '#view-library', reader: '#view-reader', notebook: '#view-notebook', excerpts: '#view-excerpts' };
    Object.entries(views).forEach(([key, selector]) => {
      const el = $(selector);
      if (el) el.hidden = key !== name;
    });
    $$('[data-view]').forEach((el) => {
      if (el.classList.contains('nav-item') || el.closest('.bottom-nav')) {
        el.classList.toggle('active', el.dataset.view === name);
      }
    });
    document.body.classList.toggle('reading', name === 'reader');
    if (name === 'notebook' && $('#resumeReading')) {
      $('#resumeReading').hidden = !state.doc;
    }
    if (name === 'library') {
      loadDocs();
      loadStats();
    } else if (name === 'notebook') {
      loadNotebook();
      loadStats();
    } else if (name === 'excerpts') {
      loadAllHighlights().then(renderExcerpts);
      loadStats();
    } else if (name === 'review') {
      startReview();
    }
    if (name !== 'reader') closeDictionary(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ---------------------------------------------------------------- events

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const nav = event.target.closest('[data-view]');
      if (nav) {
        event.preventDefault();
        if (nav.dataset.view === 'review') {
          startReview();
        } else {
          showView(nav.dataset.view);
        }
        return;
      }

      if (event.target.closest('[data-settings]')) {
        openSettings();
        return;
      }

      const deleteDoc = event.target.closest('[data-delete-doc]');
      if (deleteDoc) {
        event.stopPropagation();
        const id = Number(deleteDoc.dataset.deleteDoc);
        const doc = state.docs.find((d) => d.id === id);
        confirmDialog({
          title: `Remove “${doc ? doc.title : 'this document'}”?`,
          message: 'The document will be removed from your library. Your notebook words stay.',
          confirmLabel: 'Remove',
          danger: true,
          onConfirm: () => {
            api(`/api/documents/${id}`, { method: 'DELETE' }).then(() => {
              if (state.doc && state.doc.id === id) state.doc = null;
              loadDocs();
              loadStats();
              if (!state.doc) showView('library');
              toast('Document removed.');
            }).catch((error) => toast(error.message));
          }
        });
        return;
      }

      const docCard = event.target.closest('[data-doc-id]');
      if (docCard) {
        openDocument(Number(docCard.dataset.docId));
        return;
      }

      const nbRow = event.target.closest('[data-nb-id]');
      if (nbRow) {
        openNotebookModal(nbRow.dataset.nbId);
        return;
      }

      const recent = event.target.closest('[data-recent]');
      if (recent) {
        lookupWord(recent.dataset.recent, '');
        return;
      }

      const oxfordToggle = event.target.closest('[data-oxford]');
      if (oxfordToggle) {
        const block = oxfordToggle.closest('.source-block');
        const entry = block && block.querySelector('.oxford-entry');
        if (entry) {
          entry.classList.toggle('expanded');
          oxfordToggle.textContent = entry.classList.contains('expanded') ? 'Show less' : 'Show full entry';
        }
      }
    });

    $('#libraryAdd').addEventListener('click', pickFiles);
    $('#sideAdd').addEventListener('click', pickFiles);
    $('#dropzone').addEventListener('click', pickFiles);
    $('#dropzone').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pickFiles();
      }
    });

    const dropzone = $('#dropzone');
    ['dragenter', 'dragover'].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove('dragging');
      });
    });
    dropzone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer.files));

    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());

    $('#fileInput').addEventListener('change', (event) => {
      uploadFiles(event.target.files);
      event.target.value = '';
    });

    $('#backToLibrary').addEventListener('click', () => showView('library'));
    $('#resumeReading').addEventListener('click', () => {
      if (state.doc) showView('reader');
    });
    $('#openNotebook').addEventListener('click', () => showView('notebook'));
    $('#fontMinus').addEventListener('click', () => changeFont(-1));
    $('#fontPlus').addEventListener('click', () => changeFont(1));
    $('#themeToggle').addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      state.settings.theme = current === 'dark' ? 'light' : 'dark';
      applyTheme();
      saveSettings({ theme: state.settings.theme });
    });

    $('#readerPane').addEventListener('scroll', () => {
      hideSelectionToolbar();
      scheduleSaveProgress();
    }, { passive: true });
    document.addEventListener('mouseup', () => window.setTimeout(captureSelection, 20));
    document.addEventListener('keyup', (event) => {
      if (event.shiftKey || event.key === 'Shift' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        window.setTimeout(captureSelection, 80);
      }
    });
    let selectionTimer = null;
    document.addEventListener('selectionchange', () => {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(captureSelection, 420);
    });

    $('#textCheckBtn').addEventListener('click', () => showTextCheck(state.report));
    $('#highlightSelection').addEventListener('click', saveSelectionHighlight);
    $('#readerText').addEventListener('click', (event) => {
      const mark = event.target.closest('mark[data-highlight-id]');
      if (mark) {
        event.preventDefault();
        hideSelectionToolbar();
        openHighlightDialog(Number(mark.dataset.highlightId));
      }
    });
    document.addEventListener('mousedown', (event) => {
      if (!event.target.closest('#selectionToolbar')) hideSelectionToolbar();
    });
    $('#openExcerpts').addEventListener('click', () => {
      state.excerptDoc = state.doc ? String(state.doc.id) : '';
      showView('excerpts');
    });
    $('#excerptSearch').addEventListener('input', debounce((event) => {
      state.excerptQuery = event.target.value.trim();
      renderExcerpts();
    }, 180));
    $('#excerptDocFilter').addEventListener('change', (event) => {
      state.excerptDoc = event.target.value;
      renderExcerpts();
    });
    $('#addWordBtn').addEventListener('click', addCurrentWord);
    $('#speakBtn').addEventListener('click', () => {
      if (state.lookup) speak(state.lookup.word);
    });
    $('#closeDict').addEventListener('click', () => closeDictionary(false));

    $('#notebookSearch').addEventListener('input', debounce((event) => {
      state.notebookQuery = event.target.value.trim();
      loadNotebook(state.notebookQuery);
    }, 250));

    $('#startReviewBtn').addEventListener('click', () => startReview());
    $('#exitReview').addEventListener('click', () => {
      if (!state.review) {
        closeReview();
        return;
      }
      confirmDialog({
        title: 'End this review?',
        message: 'Your answers are saved. Remaining words stay due.',
        confirmLabel: 'End review',
        onConfirm: () => {
          if (state.review) {
            state.review = null;
            $('#reviewOverlay').hidden = true;
            document.body.style.overflow = '';
            window.clearInterval(state.timer);
            loadNotebook();
            loadStats();
            showView('notebook');
          }
        }
      });
    });

    $('#reviewCard').addEventListener('click', (event) => {
      if (event.target.closest('#revealReview')) revealReview();
    });
    $('#reviewGrades').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-grade]');
      if (btn) gradeReview(Number(btn.dataset.grade));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (modalOpen) {
          closeModal();
          return;
        }
        if (!$('#reviewOverlay').hidden) {
          if (state.review) {
            confirmDialog({
              title: 'End this review?',
              message: 'Your answers are saved.',
              confirmLabel: 'End review',
              onConfirm: () => {
                if (state.review) {
                  state.review = null;
                  $('#reviewOverlay').hidden = true;
                  document.body.style.overflow = '';
                  window.clearInterval(state.timer);
                  loadNotebook();
                  loadStats();
                  showView('notebook');
                }
              }
            });
          } else {
            closeReview();
          }
          return;
        }
        if (document.body.classList.contains('dict-open')) {
          closeDictionary(false);
          return;
        }
      }
      if (modalOpen) return;
      const tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (!$('#reviewOverlay').hidden && state.review) {
        if (event.code === 'Space' || event.key === 'Enter') {
          event.preventDefault();
          if (!state.review.answered) revealReview();
          return;
        }
        if (state.review.answered && ['1', '2', '3', '4'].includes(event.key)) {
          event.preventDefault();
          gradeReview(Number(event.key));
        }
        return;
      }
      if (event.key === 'Escape') closeDictionary(false);
    });

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (state.settings.theme === 'auto') applyTheme(); };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }

    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
    }
  }

  function changeFont(delta) {
    const next = clamp((state.settings.font_size || 18) + delta, 15, 24);
    if (next === state.settings.font_size) return;
    state.settings.font_size = next;
    applyFont();
    saveSettings({ font_size: next });
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), ms);
    };
  }

  init();
})();
