import type { BackgroundMsg, SidepanelMsg } from '../messages';
import { deriveFilename } from '../parsers/filters';
import { isGoogleSearchUrl } from '../parsers/google';
import { describeQuery } from '../parsers/queryBuilder';
import { loadSettings, saveSettings } from '../storage';
import type { DownloadItem, LinkInfo, SavedSearch, SearchQuery, SearchSource, Settings } from '../types';
import { pickDownloadSubfolder } from './folderPicker';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const modeBadge = $<HTMLSpanElement>('mode-badge');

// Quick search
const qsToggle = $<HTMLButtonElement>('qs-toggle');
const qsBody = $<HTMLDivElement>('qs-body');
const qsSite = $<HTMLInputElement>('qs-site');
const qsFiletypes = $<HTMLInputElement>('qs-filetypes');
const qsSource = $<HTMLSelectElement>('qs-source');
const qsKeywords = $<HTMLInputElement>('qs-keywords');
const qsExclude = $<HTMLInputElement>('qs-exclude');
const qsSearchBtn = $<HTMLButtonElement>('qs-search-btn');
const qsSaveBtn = $<HTMLButtonElement>('qs-save-btn');
const qsTabBtn = $<HTMLButtonElement>('qs-tab-btn');

// Saved searches
const savedSection = $<HTMLElement>('saved-section');
const savedList = $<HTMLUListElement>('saved-list');

// Settings
const settingsToggle = $<HTMLButtonElement>('settings-toggle');
const settingsBody = $<HTMLDivElement>('settings-body');
const parallelInput = $<HTMLInputElement>('parallel-input');
const maxPagesInput = $<HTMLInputElement>('maxpages-input');
const subfolderInput = $<HTMLInputElement>('subfolder-input');
const pickFolderBtn = $<HTMLButtonElement>('pick-folder-btn');
const openDlSettingsBtn = $<HTMLButtonElement>('open-dl-settings-btn');
const libraryBtn = $<HTMLButtonElement>('library-btn');

// Status
const scanProgressSection = $<HTMLElement>('scan-progress');
const scanStatus = $<HTMLElement>('scan-status');
const stopBtn = $<HTMLButtonElement>('stop-btn');

// Results
const resultsSection = $<HTMLElement>('results-section');
const resultsCount = $<HTMLElement>('results-count');
const resultsList = $<HTMLUListElement>('results-list');
const selectAllBtn = $<HTMLButtonElement>('select-all-btn');
const selectNoneBtn = $<HTMLButtonElement>('select-none-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');

// Download progress
const dlSection = $<HTMLElement>('download-progress');
const dlBar = $<HTMLProgressElement>('dl-bar');
const dlStatus = $<HTMLElement>('dl-status');
const dlList = $<HTMLUListElement>('dl-list');

// Log
const logSection = $<HTMLElement>('log-section');
const logList = $<HTMLUListElement>('log-list');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ScanContext {
  query?: string;
  source: SearchSource | 'tab' | 'generic';
}

interface State {
  port: chrome.runtime.Port | null;
  scanned: LinkInfo[];
  busy: 'scan' | 'download' | null;
  totalToDownload: number;
  completedCount: number;
  settings: Settings | null;
  /** Source/query of the most recent scan — propagated into START_DOWNLOAD for library metadata. */
  lastScanContext: ScanContext | null;
  /** Hosts touched by the most recent successful download (for "Open library [host]"). */
  lastDownloadHosts: string[];
}

const state: State = {
  port: null,
  scanned: [],
  busy: null,
  totalToDownload: 0,
  completedCount: 0,
  settings: null,
  lastScanContext: null,
  lastDownloadHosts: [],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function logError(msg: string) {
  logSection.hidden = false;
  const li = document.createElement('li');
  li.textContent = msg;
  logList.prepend(li);
  while (logList.children.length > 30) logList.lastChild?.remove();
}

function escapeText(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
}

function setBusy(kind: 'scan' | 'download' | null) {
  state.busy = kind;
  qsSearchBtn.disabled = kind !== null;
  qsTabBtn.disabled = kind !== null;
  downloadBtn.disabled = kind !== null;
  stopBtn.disabled = kind === null;
}

function readQuery(): SearchQuery {
  const filetypes = qsFiletypes.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    site: qsSite.value.trim() || undefined,
    filetypes: filetypes.length ? filetypes : undefined,
    keywords: qsKeywords.value.trim() || undefined,
    exclude: qsExclude.value.trim() || undefined,
  };
}

function writeQuery(q: SearchQuery) {
  qsSite.value = q.site ?? '';
  qsFiletypes.value = (q.filetypes ?? []).join(', ');
  qsKeywords.value = q.keywords ?? '';
  qsExclude.value = q.exclude ?? '';
}

function readSettingsFromUI(): Pick<Settings, 'maxParallel' | 'maxPages' | 'subfolderPattern'> {
  return {
    maxParallel: Math.max(1, Math.min(20, parseInt(parallelInput.value, 10) || 5)),
    maxPages: Math.max(1, Math.min(50, parseInt(maxPagesInput.value, 10) || 20)),
    subfolderPattern: subfolderInput.value.trim(),
  };
}

// ---------------------------------------------------------------------------
// Port plumbing
// ---------------------------------------------------------------------------

function connect() {
  const port = chrome.runtime.connect({ name: 'massdownload' });
  state.port = port;
  port.onDisconnect.addListener(() => {
    state.port = null;
    setBusy(null);
  });
  port.onMessage.addListener((msg: BackgroundMsg) => handleMessage(msg));
}

function send(msg: SidepanelMsg) {
  if (!state.port) connect();
  state.port?.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg: BackgroundMsg): void {
  switch (msg.type) {
    case 'SCAN_STARTED':
      modeBadge.className = 'badge ' + msg.mode;
      modeBadge.textContent = `${msg.mode} mode`;
      scanProgressSection.hidden = false;
      scanStatus.textContent = `Starting ${msg.mode} scan…`;
      break;
    case 'SCAN_PROGRESS': {
      const note = msg.note ? `[${msg.note}] ` : '';
      scanStatus.textContent = `${note}Page ${msg.page} — ${msg.foundOnPage} new, ${msg.totalUnique} unique`;
      break;
    }
    case 'SCAN_DONE':
      scanStatus.textContent = `Scan done. ${msg.items.length} matching files.`;
      renderResults(msg.items);
      setBusy(null);
      break;
    case 'SCAN_ERROR':
      scanStatus.textContent = `${msg.reason}${msg.detail ? ' — ' + msg.detail : ''}`;
      logError(`SCAN_ERROR ${msg.reason}: ${msg.detail ?? ''}`);
      setBusy(null);
      break;
    case 'DOWNLOAD_PROGRESS':
      updateDownloadItem(msg.item);
      break;
    case 'DOWNLOAD_DONE':
      dlStatus.textContent = `Done. ${msg.ok} ok, ${msg.failed} failed, ${msg.cancelled} cancelled.`;
      setBusy(null);
      break;
    case 'STOPPED':
      scanStatus.textContent = 'Stopped.';
      dlStatus.textContent = 'Stopped.';
      setBusy(null);
      break;
    case 'PONG':
      break;
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderResults(items: LinkInfo[]) {
  state.scanned = items;
  resultsSection.hidden = false;
  const newCount = items.filter((it) => !it.alreadyHave).length;
  const dupCount = items.length - newCount;
  resultsCount.textContent = dupCount > 0
    ? `${items.length} results (${newCount} new · ${dupCount} already in library)`
    : `${items.length} result${items.length === 1 ? '' : 's'}`;
  resultsList.innerHTML = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const li = document.createElement('li');
    if (item.alreadyHave) li.classList.add('already-have');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !item.alreadyHave; // unchecked by default if already in library
    cb.dataset.idx = String(i);
    label.appendChild(cb);
    let host = '';
    try { host = new URL(item.url).hostname; } catch { /* ignore */ }
    const name = deriveFilename(item);
    const badge = item.alreadyHave ? `<span class="badge tiny">in library</span>` : '';
    label.insertAdjacentHTML(
      'beforeend',
      `<span class="filename" title="${escapeText(item.url)}">${escapeText(name)}</span>${badge}<span class="host">${escapeText(host)}</span>`,
    );
    li.appendChild(label);
    resultsList.appendChild(li);
  }
}

function updateDownloadItem(item: DownloadItem) {
  let li = dlList.querySelector<HTMLLIElement>(`li[data-url="${cssEscape(item.url)}"]`);
  if (!li) {
    li = document.createElement('li');
    li.dataset.url = item.url;
    li.innerHTML = `<span class="icon"></span><span class="filename"></span>`;
    dlList.appendChild(li);
  }
  const iconSpan = li.querySelector<HTMLSpanElement>('.icon')!;
  const fnSpan = li.querySelector<HTMLSpanElement>('.filename')!;
  iconSpan.className = `icon ${item.status}`;
  iconSpan.textContent =
    item.status === 'queued' ? '·' :
    item.status === 'downloading' ? '⬇' :
    item.status === 'done' ? '✓' :
    item.status === 'failed' ? '✗' :
    '⊗';
  fnSpan.textContent = item.filename;
  fnSpan.title = item.error ? `${item.url}\n${item.error}` : item.url;

  if (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') {
    state.completedCount++;
    dlBar.value = state.completedCount;
    dlStatus.textContent = `${state.completedCount} / ${state.totalToDownload}`;
  }
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------

function renderSavedSearches() {
  const list = state.settings?.savedSearches ?? [];
  if (list.length === 0) {
    savedSection.hidden = true;
    return;
  }
  savedSection.hidden = false;
  savedList.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    const labelBtn = document.createElement('button');
    labelBtn.className = 'label';
    labelBtn.title = 'Run this search';
    labelBtn.textContent = s.label || describeQuery(s.query, s.source);
    labelBtn.addEventListener('click', () => {
      writeQuery(s.query);
      qsSource.value = s.source;
      runSearch(s.query, s.source);
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'delete';
    delBtn.title = 'Delete';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSaved(s.id);
    });
    li.appendChild(labelBtn);
    li.appendChild(delBtn);
    savedList.appendChild(li);
  }
}

async function saveCurrentSearch() {
  if (!state.settings) return;
  const q = readQuery();
  const source = qsSource.value as SearchSource;
  if (!q.site && !q.keywords) {
    logError('Nothing to save — fill in site or keywords first');
    return;
  }
  const label = describeQuery(q, source);
  const next: SavedSearch = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    query: q,
    source,
    createdAt: Date.now(),
  };
  // Avoid duplicates with same label
  const filtered = state.settings.savedSearches.filter((s) => s.label !== label);
  state.settings.savedSearches = [next, ...filtered].slice(0, 30);
  await saveSettings(state.settings);
  renderSavedSearches();
}

async function deleteSaved(id: string) {
  if (!state.settings) return;
  state.settings.savedSearches = state.settings.savedSearches.filter((s) => s.id !== id);
  await saveSettings(state.settings);
  renderSavedSearches();
}

// ---------------------------------------------------------------------------
// Search dispatch
// ---------------------------------------------------------------------------

function resetForScan() {
  resultsSection.hidden = true;
  dlSection.hidden = true;
  dlList.innerHTML = '';
  state.completedCount = 0;
  state.totalToDownload = 0;
}

async function persistCurrentSettings() {
  if (!state.settings) return;
  const ui = readSettingsFromUI();
  const filetypes = qsFiletypes.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  state.settings.maxParallel = ui.maxParallel;
  state.settings.maxPages = ui.maxPages;
  state.settings.subfolderPattern = ui.subfolderPattern;
  state.settings.targetExtensions = filetypes.length ? filetypes : ['pdf'];
  await saveSettings(state.settings);
}

async function runSearch(query: SearchQuery, source: SearchSource) {
  if (state.busy) return;
  await persistCurrentSettings();
  resetForScan();
  setBusy('scan');
  const ui = readSettingsFromUI();
  const extensions = query.filetypes ?? ['pdf'];
  const queryString = [
    query.site && `site:${query.site}`,
    query.filetypes?.length === 1 && `filetype:${query.filetypes[0]}`,
    query.keywords,
  ].filter(Boolean).join(' ').trim();
  state.lastScanContext = { query: queryString || undefined, source };
  send({
    type: 'START_SCAN_QUERY',
    query,
    source,
    extensions,
    maxPages: ui.maxPages,
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  // `lastFocusedWindow` is more reliable than `currentWindow` from a side panel:
  // currentWindow can return the side panel's host window even after the user has
  // navigated tabs in another window. lastFocusedWindow tracks the user's actual focus.
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]) return tabs[0];
  tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function runTabScan() {
  // Don't refuse if busy — background aborts the previous scan and starts fresh.
  // This avoids the case where state.busy desyncs from background's session state.
  const tab = await getActiveTab();
  if (!tab?.url || !tab.id) {
    logError('No active tab');
    return;
  }
  await persistCurrentSettings();
  resetForScan();
  setBusy('scan');
  const ui = readSettingsFromUI();
  const extensions = qsFiletypes.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  state.lastScanContext = {
    query: tab.url,
    source: isGoogleSearchUrl(tab.url) ? 'tab' : 'generic',
  };
  send({
    type: 'START_SCAN_TAB',
    tabUrl: tab.url,
    tabId: tab.id,
    extensions: extensions.length ? extensions : ['pdf'],
    maxPages: ui.maxPages,
  });
}

// ---------------------------------------------------------------------------
// Init & wiring
// ---------------------------------------------------------------------------

async function init() {
  state.settings = await loadSettings();
  qsFiletypes.value = state.settings.targetExtensions.join(', ');
  parallelInput.value = String(state.settings.maxParallel);
  maxPagesInput.value = String(state.settings.maxPages);
  subfolderInput.value = state.settings.subfolderPattern;
  renderSavedSearches();

  const tab = await getActiveTab();
  if (tab?.url) {
    if (isGoogleSearchUrl(tab.url)) {
      modeBadge.className = 'badge google';
      modeBadge.textContent = 'Google tab open';
    } else {
      modeBadge.className = 'badge generic';
      modeBadge.textContent = 'Generic page';
    }
  }

  connect();
}

qsSearchBtn.addEventListener('click', () => {
  const q = readQuery();
  if (!q.site && !q.keywords) {
    logError('Provide at least a site or keywords');
    return;
  }
  void runSearch(q, qsSource.value as SearchSource);
});

qsSaveBtn.addEventListener('click', () => void saveCurrentSearch());
qsTabBtn.addEventListener('click', () => void runTabScan());

qsToggle.addEventListener('click', () => {
  const hidden = qsBody.hidden;
  qsBody.hidden = !hidden;
  qsToggle.textContent = hidden ? 'Hide' : 'Show';
});

settingsToggle.addEventListener('click', () => {
  const hidden = settingsBody.hidden;
  settingsBody.hidden = !hidden;
  settingsToggle.textContent = hidden ? 'Hide' : 'Show';
});

downloadBtn.addEventListener('click', () => {
  const checkboxes = resultsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  const items: LinkInfo[] = [];
  for (const cb of Array.from(checkboxes)) {
    const idx = parseInt(cb.dataset.idx ?? '-1', 10);
    const item = state.scanned[idx];
    if (item) items.push(item);
  }
  if (items.length === 0) {
    logError('No results selected');
    return;
  }
  const ui = readSettingsFromUI();
  dlSection.hidden = false;
  dlList.innerHTML = '';
  state.completedCount = 0;
  state.totalToDownload = items.length;
  dlBar.max = items.length;
  dlBar.value = 0;
  dlStatus.textContent = `0 / ${items.length}`;
  // Track which hosts we'll be writing into so the side panel can offer
  // "Open library [host]" after the queue completes.
  const hosts = new Set<string>();
  for (const it of items) {
    try { hosts.add(new URL(it.url).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* ignore */ }
  }
  state.lastDownloadHosts = [...hosts];
  const ctx = state.lastScanContext;
  setBusy('download');
  send({
    type: 'START_DOWNLOAD',
    items,
    maxParallel: ui.maxParallel,
    subfolderPattern: ui.subfolderPattern,
    query: ctx?.query,
    source: ctx?.source ?? 'generic',
  });
});

pickFolderBtn.addEventListener('click', async () => {
  pickFolderBtn.disabled = true;
  const oldLabel = pickFolderBtn.textContent;
  pickFolderBtn.textContent = 'Picking…';
  try {
    const { subfolder } = await pickDownloadSubfolder();
    subfolderInput.value = subfolder;
    if (state.settings) {
      state.settings.subfolderPattern = subfolder;
      await saveSettings(state.settings);
    }
  } catch (e) {
    logError(e instanceof Error ? e.message : String(e));
  } finally {
    pickFolderBtn.disabled = false;
    pickFolderBtn.textContent = oldLabel;
  }
});

libraryBtn.addEventListener('click', async () => {
  // Pick the most relevant host: last download host > active tab host > nothing
  let host = state.lastDownloadHosts[0];
  if (!host) {
    const tab = await getActiveTab();
    if (tab?.url) {
      try { host = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* ignore */ }
    }
  }
  if (!host) {
    logError('No host known yet — run a scan first');
    return;
  }
  // Find the matching library.html download (already saved by background) and reveal it.
  // Library file name pattern: "MassDownload/<host>/library.html"
  const needle = `MassDownload\\${host}\\library.html`.replace(/\\/g, '/');
  chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 }, (results) => {
    const hit = results.find((r) => r.filename.replace(/\\/g, '/').endsWith(needle));
    if (!hit) {
      logError(`No library yet for ${host} — download some files first`);
      return;
    }
    // Show in folder if file:// access isn't enabled (Edge/Chrome default).
    chrome.downloads.show(hit.id);
  });
});

openDlSettingsBtn.addEventListener('click', () => {
  // Detect Edge vs Chrome from UA. Edge always includes "Edg/" in its UA string.
  const isEdge = /\bEdg\//.test(navigator.userAgent);
  const url = isEdge ? 'edge://settings/downloads' : 'chrome://settings/downloads';
  chrome.tabs.create({ url }).catch((e) => logError(`Could not open ${url}: ${e}`));
});

stopBtn.addEventListener('click', () => send({ type: 'STOP' }));
selectAllBtn.addEventListener('click', () => {
  resultsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => (c.checked = true));
});
selectNoneBtn.addEventListener('click', () => {
  resultsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => (c.checked = false));
});

init().catch((e) => logError(`Init failed: ${e instanceof Error ? e.message : String(e)}`));
