import type { LibraryRequest, LibraryResponse } from '../messages';
import type { LibraryEntry } from '../types';

// ---------------------------------------------------------------------------
// Background round-trip helper
// ---------------------------------------------------------------------------

function callBg(req: LibraryRequest): Promise<LibraryResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (response: LibraryResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'sendMessage failed' });
        return;
      }
      resolve(response ?? { ok: false, error: 'no response' });
    });
  });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const titleEl = $<HTMLHeadingElement>('title');
const statsEl = $<HTMLDivElement>('stats');
const qInput = $<HTMLInputElement>('q');
const hostSelect = $<HTMLSelectElement>('host');
const sortSelect = $<HTMLSelectElement>('sort');
const sourceSelect = $<HTMLSelectElement>('source');
const exportJsonBtn = $<HTMLButtonElement>('export-json');
const exportCsvBtn = $<HTMLButtonElement>('export-csv');
const exportHtmlBtn = $<HTMLButtonElement>('export-html');
const tagFilterEl = $<HTMLDivElement>('tag-filter');
const main = $<HTMLElement>('entries');
const saveIndicator = $<HTMLSpanElement>('save-indicator');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let entries: LibraryEntry[] = [];
let activeTags = new Set<string>();
let openEditorId: string | null = null;

const params = new URLSearchParams(location.search);
const initialHost = params.get('host') ?? '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtDate = (ms: number) => new Date(ms).toLocaleString();
const fmtSize = (b: number | null | undefined) => {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0,
    v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 10 ? 0 : 1) + ' ' + u[i];
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileUrl(path: string): string {
  return 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function highlight(text: string | null | undefined, q: string): string {
  if (!q || !text) return escapeHtml(text ?? '');
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return escapeHtml(text).replace(re, '<mark>$1</mark>');
}

function setSaveIndicator(state: 'idle' | 'saving' | 'saved') {
  saveIndicator.className = state === 'idle' ? '' : state;
  saveIndicator.textContent =
    state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : '';
  if (state === 'saved') {
    setTimeout(() => setSaveIndicator('idle'), 1500);
  }
}

// ---------------------------------------------------------------------------
// Filter / sort
// ---------------------------------------------------------------------------

function displayTitle(e: LibraryEntry): string {
  return e.customTitle || e.title || e.filename || e.url;
}

function applyFilters(): LibraryEntry[] {
  const q = qInput.value.trim().toLowerCase();
  const host = hostSelect.value;
  const source = sourceSelect.value;
  return entries.filter((e) => {
    if (host && e.host !== host) return false;
    if (source && e.source !== source) return false;
    if (activeTags.size > 0) {
      const tags = new Set((e.tags ?? []).map((t) => t.toLowerCase()));
      for (const t of activeTags) if (!tags.has(t)) return false;
    }
    if (!q) return true;
    return (
      (e.customTitle ?? '').toLowerCase().includes(q) ||
      (e.title ?? '').toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.url ?? '').toLowerCase().includes(q) ||
      (e.query ?? '').toLowerCase().includes(q) ||
      (e.filename ?? '').toLowerCase().includes(q) ||
      (e.notes ?? '').toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

function applySort(items: LibraryEntry[]): LibraryEntry[] {
  const out = [...items];
  switch (sortSelect.value) {
    case 'dl-asc':
      return out.sort((a, b) => a.downloadedAt - b.downloadedAt);
    case 'title-asc':
      return out.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
    case 'title-desc':
      return out.sort((a, b) => displayTitle(b).localeCompare(displayTitle(a)));
    case 'size-asc':
      return out.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    case 'size-desc':
      return out.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    default:
      return out.sort((a, b) => b.downloadedAt - a.downloadedAt);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderHostFilter() {
  const hosts = [...new Set(entries.map((e) => e.host))].sort();
  hostSelect.innerHTML = '<option value="">All hosts</option>';
  for (const h of hosts) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    if (h === initialHost) opt.selected = true;
    hostSelect.appendChild(opt);
  }
}

function renderSourceFilter() {
  const sources = [...new Set(entries.map((e) => e.source))].sort();
  sourceSelect.innerHTML = '<option value="">All sources</option>';
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sourceSelect.appendChild(opt);
  }
}

function renderTagFilter() {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.tags) continue;
    for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  tagFilterEl.innerHTML = '';
  if (sorted.length === 0) return;
  for (const [tag, count] of sorted) {
    const btn = document.createElement('button');
    btn.textContent = `${tag} (${count})`;
    if (activeTags.has(tag)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (activeTags.has(tag)) activeTags.delete(tag);
      else activeTags.add(tag);
      renderTagFilter();
      render();
    });
    tagFilterEl.appendChild(btn);
  }
}

function render() {
  const filtered = applySort(applyFilters());
  const totalSize = filtered.reduce((s, e) => s + (e.size ?? 0), 0);
  statsEl.textContent =
    filtered.length === entries.length
      ? `${entries.length} files · ${fmtSize(totalSize)}`
      : `${filtered.length} of ${entries.length} files · ${fmtSize(totalSize)}`;

  if (filtered.length === 0) {
    main.innerHTML =
      entries.length === 0
        ? '<div class="empty">No files in the library yet. Run a scan and download something to fill this up.</div>'
        : '<div class="empty">No matches for the current filters.</div>';
    return;
  }

  const q = qInput.value.trim();
  main.innerHTML = filtered
    .map((e) => {
      const title = displayTitle(e);
      const tagsHtml =
        e.tags && e.tags.length
          ? `<span class="tags">${e.tags
              .map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`)
              .join('')}</span>`
          : '';
      const meta = [
        `<span class="badge">${escapeHtml(e.extension || 'file')}</span>`,
        e.size ? escapeHtml(fmtSize(e.size)) : '',
        escapeHtml(fmtDate(e.downloadedAt)),
        escapeHtml(e.source),
        e.query ? `query: <em>${escapeHtml(e.query)}</em>` : '',
        `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">source</a>`,
      ]
        .filter(Boolean)
        .join(' · ');
      const editorOpen = openEditorId === e.id;
      return `
        <article class="card" data-id="${escapeHtml(e.id)}">
          <h2 class="card-title">
            <a href="${escapeHtml(fileUrl(e.localPath))}" target="_blank" rel="noopener" title="${escapeHtml(e.localPath)}">${highlight(title, q)}</a>
            ${tagsHtml}
            <button class="card-title-edit" data-action="edit">${editorOpen ? 'Cancel' : 'Edit'}</button>
          </h2>
          <div class="card-meta">${meta}</div>
          ${e.description ? `<p class="card-desc">${highlight(e.description, q)}</p>` : ''}
          ${e.notes ? `<div class="card-desc" style="opacity:.85">📝 ${highlight(e.notes, q)}</div>` : ''}
          ${editorOpen ? renderEditor(e) : ''}
          <div class="card-actions">
            <button data-action="show-folder">📂 Show in folder</button>
            <button data-action="copy-url">🔗 Copy source URL</button>
            <button class="danger" data-action="remove">🗑 Remove from library</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderEditor(e: LibraryEntry): string {
  return `
    <div class="editor" data-editor-for="${escapeHtml(e.id)}">
      <label>
        Custom title (overrides "${escapeHtml(e.title ?? e.filename)}")
        <input type="text" data-field="customTitle" value="${escapeHtml(e.customTitle ?? '')}" placeholder="${escapeHtml(e.title ?? '')}" />
      </label>
      <label>
        Tags (comma-separated)
        <input type="text" data-field="tags" value="${escapeHtml((e.tags ?? []).join(', '))}" placeholder="legal, 2024, urgent" />
      </label>
      <label>
        Notes
        <textarea data-field="notes" placeholder="Personal notes about this document…">${escapeHtml(e.notes ?? '')}</textarea>
      </label>
      <div class="editor-actions">
        <button data-action="cancel-edit">Cancel</button>
        <button class="save" data-action="save-edit">Save</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

main.addEventListener('click', async (ev) => {
  const target = ev.target as HTMLElement;
  const action = target.dataset.action;
  if (!action) return;
  const card = target.closest('.card') as HTMLElement | null;
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  if (action === 'edit') {
    openEditorId = openEditorId === id ? null : id;
    render();
  } else if (action === 'cancel-edit') {
    openEditorId = null;
    render();
  } else if (action === 'save-edit') {
    const editor = card.querySelector('.editor') as HTMLElement | null;
    if (!editor) return;
    const customTitle = (editor.querySelector('[data-field="customTitle"]') as HTMLInputElement).value;
    const tagsRaw = (editor.querySelector('[data-field="tags"]') as HTMLInputElement).value;
    const notes = (editor.querySelector('[data-field="notes"]') as HTMLTextAreaElement).value;
    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    setSaveIndicator('saving');
    const res = await callBg({
      type: 'LIBRARY_UPDATE_ENTRY',
      id,
      patch: { customTitle, tags, notes },
    });
    if (!res.ok) {
      console.error('Save failed:', res.error);
      setSaveIndicator('idle');
      return;
    }
    if ('entry' in res && res.entry) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx >= 0) entries[idx] = res.entry;
    }
    openEditorId = null;
    setSaveIndicator('saved');
    renderTagFilter();
    render();
  } else if (action === 'remove') {
    if (!confirm('Remove this entry from the library? The file on disk is NOT deleted.')) return;
    const res = await callBg({ type: 'LIBRARY_REMOVE_ENTRY', id });
    if (!res.ok) {
      alert('Failed: ' + (('error' in res && res.error) || 'unknown'));
      return;
    }
    entries = entries.filter((e) => e.id !== id);
    renderTagFilter();
    render();
  } else if (action === 'show-folder') {
    if (entry.downloadId !== undefined) {
      chrome.downloads.show(entry.downloadId);
    }
  } else if (action === 'copy-url') {
    await navigator.clipboard.writeText(entry.url).catch(() => undefined);
    target.textContent = '✓ Copied';
    setTimeout(() => { target.textContent = '🔗 Copy source URL'; }, 1200);
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 250);
}

function csvEscape(s: unknown): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function toCsv(rows: LibraryEntry[]): string {
  const headers = [
    'customTitle',
    'title',
    'filename',
    'url',
    'description',
    'tags',
    'notes',
    'query',
    'source',
    'extension',
    'size',
    'downloadedAt',
    'localPath',
    'host',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = (r as unknown as Record<string, unknown>)[h];
          if (h === 'downloadedAt' && typeof v === 'number') return csvEscape(new Date(v).toISOString());
          if (h === 'tags' && Array.isArray(v)) return csvEscape(v.join('; '));
          return csvEscape(v ?? '');
        })
        .join(','),
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}

exportJsonBtn.addEventListener('click', () => {
  const data = applySort(applyFilters());
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(
    `massdownload-library-${ts}.json`,
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
});

exportCsvBtn.addEventListener('click', () => {
  const data = applySort(applyFilters());
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(`massdownload-library-${ts}.csv`, new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' }));
});

exportHtmlBtn.addEventListener('click', async () => {
  const host = hostSelect.value;
  if (!host) {
    alert('Pick a single host first — portable HTML is generated per host.');
    return;
  }
  const res = await callBg({ type: 'LIBRARY_REGENERATE_DISK_HTML', host });
  if (!res.ok) {
    alert('Failed: ' + (('error' in res && res.error) || 'unknown'));
    return;
  }
  alert(`Regenerated Downloads/MassDownload/${host}/library.html`);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let renderTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
}

qInput.addEventListener('input', scheduleRender);
hostSelect.addEventListener('change', () => {
  // Update title to reflect selection.
  titleEl.textContent = hostSelect.value
    ? `MassDownload Library — ${hostSelect.value}`
    : 'MassDownload Library';
  render();
});
sortSelect.addEventListener('change', render);
sourceSelect.addEventListener('change', render);

async function init() {
  const res = await callBg({ type: 'LIBRARY_LIST', host: initialHost || undefined });
  if (!res.ok) {
    main.innerHTML = `<div class="empty">Failed to load library: ${escapeHtml((('error' in res && res.error) || 'unknown'))}</div>`;
    return;
  }
  if (!('entries' in res)) {
    main.innerHTML = '<div class="empty">Unexpected response.</div>';
    return;
  }
  entries = res.entries;
  if (initialHost) {
    titleEl.textContent = `MassDownload Library — ${initialHost}`;
  }
  renderHostFilter();
  renderSourceFilter();
  renderTagFilter();
  render();
}

init().catch((e) => {
  main.innerHTML = `<div class="empty">Init failed: ${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
});
