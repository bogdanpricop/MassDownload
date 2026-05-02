import type { LibraryEntry } from '../types';

/**
 * Generate a single self-contained HTML file for a host's library.
 *
 * Design constraints:
 *   - Zero external dependencies (works offline, opens via `file://`).
 *   - Data embedded in a `<script>` block — no fetch, no CORS issues.
 *   - Light/dark theme via `prefers-color-scheme`.
 *   - Live search (debounced 100ms), filter by source/query, sort by date/title/size.
 *   - Cards link to the local file via `file:///absolute/path`.
 *
 * The output is intentionally read-only: edits to the HTML are not synced back
 * to the extension. The HTML is regenerated whenever the library changes.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJs(s: string): string {
  // Escape for embedding inside a JSON string in <script>. We use JSON.stringify
  // for the actual data, but the closing-tag protection still applies.
  return s.replace(/<\/script/gi, '<\\/script');
}

export function generateLibraryHtml(host: string, entries: LibraryEntry[]): string {
  const title = `MassDownload Library — ${host}`;
  const data = JSON.stringify(
    entries.map((e) => ({
      id: e.id,
      url: e.url,
      filename: e.filename,
      localPath: e.localPath,
      host: e.host,
      title: e.title ?? null,
      description: e.description ?? null,
      query: e.query ?? null,
      source: e.source,
      extension: e.extension,
      discoveredAt: e.discoveredAt,
      downloadedAt: e.downloadedAt,
      size: e.size ?? null,
    })),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #6b7280;
    --border: #d0d7de;
    --primary: #1f6feb;
    --bg-subtle: #f6f8fa;
    --shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --muted: #8b949e;
      --border: #30363d;
      --primary: #4493f8;
      --bg-subtle: #161b22;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--fg);
    font-size: 14px;
    line-height: 1.5;
  }
  header {
    position: sticky;
    top: 0;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    z-index: 10;
  }
  h1 {
    margin: 0 0 4px 0;
    font-size: 18px;
    font-weight: 600;
  }
  .stats {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 12px;
  }
  .controls {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  input[type="search"], select, button.export {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  input[type="search"] {
    flex: 1;
    min-width: 200px;
  }
  button.export {
    cursor: pointer;
    font-size: 12px;
  }
  button.export:hover {
    background: var(--bg-subtle);
  }
  input[type="search"]:focus, select:focus {
    outline: 2px solid var(--primary);
    outline-offset: -1px;
  }
  main {
    padding: 16px 24px 64px 24px;
    max-width: 1100px;
    margin: 0 auto;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    padding: 64px 16px;
  }
  .card {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 12px;
    box-shadow: var(--shadow);
  }
  .card-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px 0;
  }
  .card-title a {
    color: var(--primary);
    text-decoration: none;
  }
  .card-title a:hover {
    text-decoration: underline;
  }
  .card-meta {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin-bottom: 6px;
  }
  .card-meta a {
    color: var(--muted);
    text-decoration: none;
  }
  .card-meta a:hover {
    color: var(--primary);
    text-decoration: underline;
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .card-desc {
    color: var(--fg);
    font-size: 13px;
    margin: 6px 0 0 0;
    word-break: break-word;
  }
  mark {
    background: rgba(255, 217, 0, 0.4);
    color: inherit;
    padding: 0 2px;
    border-radius: 2px;
  }
  footer {
    text-align: center;
    color: var(--muted);
    font-size: 11px;
    padding: 24px;
    border-top: 1px solid var(--border);
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="stats" id="stats"></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Search title, description, query, URL…" autofocus />
    <select id="sort">
      <option value="dl-desc">Newest first</option>
      <option value="dl-asc">Oldest first</option>
      <option value="title-asc">Title A→Z</option>
      <option value="title-desc">Title Z→A</option>
      <option value="size-desc">Largest first</option>
      <option value="size-asc">Smallest first</option>
    </select>
    <select id="source">
      <option value="">All sources</option>
    </select>
    <button class="export" id="export-json" title="Download the current filtered list as JSON">↓ JSON</button>
    <button class="export" id="export-csv" title="Download the current filtered list as CSV">↓ CSV</button>
  </div>
</header>
<main id="entries"></main>
<footer>Generated by MassDownload — open this HTML directly with your browser.</footer>
<script>
const ENTRIES = ${escapeJs(data)};
const fmtDate = (ms) => new Date(ms).toLocaleString();
const fmtSize = (b) => {
  if (!b && b !== 0) return '';
  const u = ['B','KB','MB','GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 ? 0 : 1) + ' ' + u[i];
};
const escapeHtml = (s) => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const fileUrl = (path) => 'file:///' + path.replace(/\\\\/g, '/').replace(/^\\/+/, '');

function highlight(text, q) {
  if (!q || !text) return escapeHtml(text ?? '');
  const re = new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
  return escapeHtml(text).replace(re, '<mark>$1</mark>');
}

function populateSourceFilter() {
  const sel = document.getElementById('source');
  const sources = [...new Set(ENTRIES.map(e => e.source))].sort();
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
}

function applyFilters(q, source) {
  const ql = q.trim().toLowerCase();
  return ENTRIES.filter(e => {
    if (source && e.source !== source) return false;
    if (!ql) return true;
    return (
      (e.title || '').toLowerCase().includes(ql) ||
      (e.description || '').toLowerCase().includes(ql) ||
      (e.url || '').toLowerCase().includes(ql) ||
      (e.query || '').toLowerCase().includes(ql) ||
      (e.filename || '').toLowerCase().includes(ql)
    );
  });
}

function applySort(items, mode) {
  const out = [...items];
  switch (mode) {
    case 'dl-asc': out.sort((a,b) => a.downloadedAt - b.downloadedAt); break;
    case 'title-asc': out.sort((a,b) => (a.title||a.filename||'').localeCompare(b.title||b.filename||'')); break;
    case 'title-desc': out.sort((a,b) => (b.title||b.filename||'').localeCompare(a.title||a.filename||'')); break;
    case 'size-asc': out.sort((a,b) => (a.size||0) - (b.size||0)); break;
    case 'size-desc': out.sort((a,b) => (b.size||0) - (a.size||0)); break;
    default: out.sort((a,b) => b.downloadedAt - a.downloadedAt);
  }
  return out;
}

function render() {
  const q = document.getElementById('q').value;
  const source = document.getElementById('source').value;
  const sort = document.getElementById('sort').value;
  const filtered = applySort(applyFilters(q, source), sort);

  const stats = document.getElementById('stats');
  const totalSize = filtered.reduce((s, e) => s + (e.size || 0), 0);
  stats.textContent = filtered.length === ENTRIES.length
    ? \`\${ENTRIES.length} files · \${fmtSize(totalSize)}\`
    : \`\${filtered.length} of \${ENTRIES.length} files · \${fmtSize(totalSize)}\`;

  const main = document.getElementById('entries');
  if (filtered.length === 0) {
    main.innerHTML = '<div class="empty">No matches.</div>';
    return;
  }
  main.innerHTML = filtered.map(e => {
    const titleText = e.title || e.filename || e.url;
    const meta = [
      \`<span class="badge">\${escapeHtml(e.extension || 'file')}</span>\`,
      e.size ? escapeHtml(fmtSize(e.size)) : '',
      escapeHtml(fmtDate(e.downloadedAt)),
      escapeHtml(e.source),
      e.query ? \`query: <em>\${escapeHtml(e.query)}</em>\` : '',
      \`<a href="\${escapeHtml(e.url)}" target="_blank" rel="noopener">source</a>\`,
    ].filter(Boolean).join(' · ');
    return \`
      <article class="card">
        <h2 class="card-title">
          <a href="\${escapeHtml(fileUrl(e.localPath))}" target="_blank" rel="noopener" title="\${escapeHtml(e.localPath)}">\${highlight(titleText, q)}</a>
        </h2>
        <div class="card-meta">\${meta}</div>
        \${e.description ? \`<p class="card-desc">\${highlight(e.description, q)}</p>\` : ''}
      </article>
    \`;
  }).join('');
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
}

// Export current filtered list ---------------------------------------------
function currentFiltered() {
  const q = document.getElementById('q').value;
  const source = document.getElementById('source').value;
  const sort = document.getElementById('sort').value;
  return applySort(applyFilters(q, source), sort);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
}

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  // RFC 4180: wrap in quotes if it contains comma, quote, CR or LF; double up internal quotes.
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function toCsv(rows) {
  const headers = ['title','filename','url','description','query','source','extension','size','downloadedAt','localPath','host'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h];
      if (h === 'downloadedAt' && typeof v === 'number') return csvEscape(new Date(v).toISOString());
      return csvEscape(v ?? '');
    }).join(','));
  }
  // BOM helps Excel detect UTF-8.
  return '\uFEFF' + lines.join('\r\n');
}

document.getElementById('export-json').addEventListener('click', () => {
  const data = currentFiltered();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(\`massdownload-library-\${ts}.json\`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
});

document.getElementById('export-csv').addEventListener('click', () => {
  const data = currentFiltered();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(\`massdownload-library-\${ts}.csv\`, new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' }));
});

document.getElementById('q').addEventListener('input', scheduleRender);
document.getElementById('source').addEventListener('change', render);
document.getElementById('sort').addEventListener('change', render);
populateSourceFilter();
render();
</script>
</body>
</html>`;
}
