import { buildGooglePageUrl, isGoogleSearchUrl } from './parsers/google';
import { buildBingPageUrl } from './parsers/bing';
import { buildBingQueryUrl, buildGoogleQueryUrl, buildSiteOrigin } from './parsers/queryBuilder';
import { extractSitemapsFromRobots } from './parsers/sitemap';
import { canonicalizeUrl, filterAndDedup } from './parsers/filters';
import { startQueue, type DownloaderHandle } from './downloader';
import { addEntries, getEntries, knownCanonicalUrls } from './library/manifest';
import { generateLibraryHtml } from './library/htmlGenerator';
import type {
  BackgroundMsg,
  OffscreenMsg,
  OffscreenResponse,
  SidepanelMsg,
} from './messages';
import type { LinkInfo, ScanErrorReason, SearchQuery, SearchSource } from './types';

const OFFSCREEN_PATH = 'src/offscreen.html';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[MassDownload] setPanelBehavior failed:', e));
});

// ---------------------------------------------------------------------------
// Offscreen document — DOMParser host
// ---------------------------------------------------------------------------

let offscreenCreating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const exists = await chrome.offscreen.hasDocument().catch(() => false);
  if (exists) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse Google/Bing HTML and sitemap XML with DOMParser.',
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

async function callOffscreen(msg: OffscreenMsg): Promise<OffscreenResponse> {
  await ensureOffscreenDocument();
  return new Promise<OffscreenResponse>((resolve) => {
    chrome.runtime.sendMessage(msg, (response: OffscreenResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'sendMessage failed' });
        return;
      }
      resolve(response ?? { ok: false, error: 'no response from offscreen' });
    });
  });
}

// ---------------------------------------------------------------------------
// Per-port session state
// ---------------------------------------------------------------------------

interface Session {
  port: chrome.runtime.Port;
  scanAbort: AbortController | null;
  downloader: DownloaderHandle | null;
  /** Leftover scan tab from a previous CAPTCHA, kept open so the user can solve it.
   *  Reused on the next scan so we don't accumulate tabs. */
  scanTabId: number | null;
}

const sessions = new Set<Session>();

function send(port: chrome.runtime.Port, msg: BackgroundMsg) {
  try {
    port.postMessage(msg);
  } catch {
    /* port disconnected */
  }
}

// ---------------------------------------------------------------------------
// Google scanning
// ---------------------------------------------------------------------------

interface GoogleScanResult {
  items: LinkInfo[];
  /** True if scan halted early due to CAPTCHA. */
  captcha: boolean;
  /** True if scan failed for a reason other than CAPTCHA. */
  failed: boolean;
  errorDetail?: string;
}

// Google caps `num` at ~10 since late 2024. Pagination MUST step by 10.
const GOOGLE_PAGE_STEP = 10;
const TAB_LOAD_TIMEOUT_MS = 30000;
const HUMAN_MIN_DELAY_MS = 800;
const HUMAN_MAX_DELAY_MS = 2000;

type TabWaitOpts = {
  /** If true, require a `loading → complete` transition (no fast-path).
   *  Use after `tabs.update({ url })` because the tab briefly remains in
   *  `complete` from the previous page before transitioning. */
  requireFreshLoad?: boolean;
};

/**
 * Wait until a tab finishes loading, or reject on timeout / tab close / abort.
 */
function waitForTabComplete(
  tabId: number,
  signal: AbortSignal,
  opts: TabWaitOpts = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawLoading = !opts.requireFreshLoad;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Tab load timeout'));
    }, TAB_LOAD_TIMEOUT_MS);

    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id: number) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error('Scan tab was closed'));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    // Fast path only when we don't require a fresh load
    if (!opts.requireFreshLoad) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        if (tab.status === 'complete') {
          cleanup();
          resolve();
        }
      });
    }
  });
}

/**
 * Navigate a tab and wait for the new page to fully load.
 * Listener is registered BEFORE update() so we never miss the loading status.
 */
async function navigateTabAndWait(tabId: number, url: string, signal: AbortSignal): Promise<void> {
  const wait = waitForTabComplete(tabId, signal, { requireFreshLoad: true });
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'tabs.update failed'));
      } else {
        resolve();
      }
    });
  });
  await wait;
}

/** Make a tab visible: activate it AND focus its window. */
async function surfaceTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true, autoDiscardable: true });
    if (tab.windowId !== undefined && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    }
  } catch {
    /* tab may have been closed; nothing more to do */
  }
}

/** Try to reuse a tab by id; returns false if it's gone. */
async function tabStillExists(tabId: number | null): Promise<boolean> {
  if (tabId === null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inline function injected into the Google SERP tab. Must be self-contained
 * (no external references — `chrome.scripting.executeScript` serializes it).
 */
function extractGoogleInPage(): {
  items: { url: string; title?: string; description?: string }[];
  isCaptcha: boolean;
} {
  // CAPTCHA detection — only definitive signals to avoid false positives.
  const isCaptcha =
    /\/sorry\//i.test(location.href) ||
    !!document.querySelector('form#captcha-form');

  const internalHosts = [
    'google.com',
    'webcache.googleusercontent.com',
    'translate.google.com',
    'accounts.google.com',
    'support.google.com',
    'policies.google.com',
    'maps.google.com',
    'youtube.com',
    'gstatic.com',
  ];

  // Snippet (description) selectors. Google rotates class names, so we try a few.
  const snippetSelectors = [
    '.VwiC3b',
    '.MUxGbd',
    '[data-snc] span',
    '[role="text"]',
  ];

  function extractDescription(container: Element | null): string | undefined {
    if (!container) return undefined;
    for (const sel of snippetSelectors) {
      const el = container.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && text.length >= 20) return text.slice(0, 600);
    }
    // Fallback: any span with substantial text that isn't title/url
    const spans = container.querySelectorAll('span, div');
    for (const s of Array.from(spans)) {
      const t = (s.textContent ?? '').trim();
      if (t.length < 30 || t.length > 600) continue;
      if (s.closest('h3') || s.closest('cite')) continue;
      // Skip if it's just a URL or breadcrumb path
      if (/^https?:\/\//.test(t) || /^[\w.-]+\.(com|org|net|ro|gov|edu)/.test(t)) continue;
      return t;
    }
    return undefined;
  }

  const items: { url: string; title?: string; description?: string }[] = [];
  const seen = new Set<string>();

  const anchors = document.querySelectorAll('a[href]');
  for (const a of Array.from(anchors)) {
    const href = a.getAttribute('href');
    if (!href) continue;
    if (a.closest('.kp-blk, .related-question-pair, .commercial-unit-desktop-top, .ads-fr')) continue;

    let real: string | null = null;
    try {
      const u = new URL(href, 'https://www.google.com');
      if (u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q && /^https?:\/\//i.test(q)) real = q;
      } else if (/^https?:$/i.test(u.protocol)) {
        const h = u.hostname.toLowerCase();
        const isInternal = internalHosts.some(
          (needle) => h === needle || h.startsWith(needle) || h.endsWith('.' + needle),
        );
        if (!isInternal) real = u.toString();
      }
    } catch {
      continue;
    }

    if (!real || seen.has(real)) continue;
    seen.add(real);

    const container = a.closest('div.g, div.tF2Cxc, div[data-hveid]');

    let title: string | undefined;
    const innerH3 = a.querySelector('h3');
    if (innerH3 && innerH3.textContent) {
      title = innerH3.textContent.trim();
    } else {
      const h3 = container ? container.querySelector('h3') : null;
      if (h3 && h3.textContent) title = h3.textContent.trim();
    }

    const description = extractDescription(container);

    items.push({ url: real, title, description });
  }

  return { items, isCaptcha };
}

interface ScanTabSpec {
  tabId: number;
  /** True if MassDownload created this tab (close on success/abort).
   *  False if it's the user's own tab (never close — leave them on the last page). */
  ownTab: boolean;
}

/**
 * Stealth Google scan in a real tab — paginates with `tabs.update` (loading→complete cycle),
 * extracts links via in-page `executeScript`, with random human-like delays.
 *
 * Why this is safe vs background fetch:
 *   - real tab with user's session cookies
 *   - normal page-load timings (loading → complete) for every transition
 *   - randomized delays between pages, not back-to-back fetches
 */
async function scanGoogleViaTab(
  port: chrome.runtime.Port,
  session: Session,
  spec: ScanTabSpec,
  initialUrl: string,
  signal: AbortSignal,
  maxPages: number,
): Promise<GoogleScanResult> {
  const { tabId, ownTab } = spec;
  const items: LinkInfo[] = [];
  const seen = new Set<string>();
  let consecutiveEmpty = 0;
  let leaveTabOpen = false;

  // Prevent Chrome from discarding the tab during a long scan.
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* not critical */
  }

  // On user STOP, only close OUR tab — never close the user's own tab.
  const onAbortClose = () => {
    if (ownTab) chrome.tabs.remove(tabId).catch(() => {});
  };
  signal.addEventListener('abort', onAbortClose, { once: true });

  try {
    // Always navigate explicitly to the initial URL with a proper loading→complete wait.
    // This works for both freshly created tabs and reused/user tabs.
    try {
      await navigateTabAndWait(tabId, initialUrl, signal);
    } catch (e) {
      return {
        items,
        captcha: false,
        failed: true,
        errorDetail: `Initial navigation: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Settle for client-side hydration.
    await new Promise((r) => setTimeout(r, 300));
    if (signal.aborted) return { items, captcha: false, failed: false };

    for (let page = 0; page < maxPages; page++) {
      if (signal.aborted) break;

      let scriptResults: chrome.scripting.InjectionResult<{
        items: { url: string; title?: string }[];
        isCaptcha: boolean;
      }>[];
      try {
        scriptResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractGoogleInPage,
        });
      } catch (e) {
        return {
          items,
          captcha: false,
          failed: true,
          errorDetail: `executeScript: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const parsed = scriptResults[0]?.result;
      if (!parsed) {
        return { items, captcha: false, failed: true, errorDetail: 'Page extraction returned no result' };
      }

      if (parsed.isCaptcha) {
        leaveTabOpen = true;
        await surfaceTab(tabId);
        return {
          items,
          captcha: true,
          failed: false,
          errorDetail: 'Google CAPTCHA — solve it in the highlighted tab, then click Search again',
        };
      }

      const before = seen.size;
      for (const item of parsed.items) {
        try {
          const canonical = new URL(item.url).toString();
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          items.push(item);
        } catch {
          /* ignore */
        }
      }
      const newOnPage = seen.size - before;

      const start = page * GOOGLE_PAGE_STEP;
      send(port, {
        type: 'SCAN_PROGRESS',
        page: page + 1,
        foundOnPage: newOnPage,
        totalUnique: seen.size,
        note: `Google tab page ${page + 1} (start=${start})`,
      });

      if (newOnPage === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }

      // Navigate to next page with a random human-like delay.
      if (page + 1 < maxPages) {
        const delay = HUMAN_MIN_DELAY_MS + Math.random() * (HUMAN_MAX_DELAY_MS - HUMAN_MIN_DELAY_MS);
        await new Promise((r) => setTimeout(r, delay));
        if (signal.aborted) break;
        const nextUrl = buildGooglePageUrl(initialUrl, (page + 1) * GOOGLE_PAGE_STEP);
        try {
          await navigateTabAndWait(tabId, nextUrl, signal);
        } catch (e) {
          return {
            items,
            captcha: false,
            failed: true,
            errorDetail: `Navigation: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        // Brief settle after each navigation.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbortClose);
    if (ownTab) {
      if (leaveTabOpen) {
        // Remember our scan tab so the next Quick Search reuses it instead of stacking.
        session.scanTabId = tabId;
      } else {
        // Done with our tab — close it.
        chrome.tabs.remove(tabId).catch(() => {});
        if (session.scanTabId === tabId) session.scanTabId = null;
      }
    }
    // If !ownTab (user's tab): never close it, never claim it as our scanTabId.
  }

  return { items, captcha: false, failed: false };
}

/**
 * Resolve a Google scan tab: reuse `session.scanTabId` if still valid,
 * else create a fresh background tab. The returned spec is fed to scanGoogleViaTab.
 */
async function acquireOwnedScanTab(session: Session): Promise<ScanTabSpec> {
  if (await tabStillExists(session.scanTabId)) {
    return { tabId: session.scanTabId!, ownTab: true };
  }
  session.scanTabId = null;
  const tab = await chrome.tabs.create({ active: false });
  if (!tab.id) throw new Error('Could not create scan tab');
  session.scanTabId = tab.id;
  return { tabId: tab.id, ownTab: true };
}

// ---------------------------------------------------------------------------
// Bing scanning
// ---------------------------------------------------------------------------

async function scanBingSerp(
  port: chrome.runtime.Port,
  startUrl: string,
  signal: AbortSignal,
  maxPages: number,
  countPerPage = 50,
): Promise<GoogleScanResult> {
  const items: LinkInfo[] = [];
  const seen = new Set<string>();
  let consecutiveEmpty = 0;

  for (let page = 0; page < maxPages; page++) {
    if (signal.aborted) break;
    const first = 1 + page * countPerPage;
    const url = buildBingPageUrl(startUrl, first, countPerPage);

    let res: Response;
    try {
      res = await fetch(url, {
        credentials: 'include',
        signal,
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      });
    } catch (e) {
      if (signal.aborted) break;
      return { items, captcha: false, failed: true, errorDetail: e instanceof Error ? e.message : String(e) };
    }
    // Authoritative CAPTCHA check by final URL (after redirects)
    if (/\/challenge\/|\/sorry\/|\/blocked\b/i.test(res.url)) {
      return { items, captcha: true, failed: false, errorDetail: `Bing redirected to ${res.url}` };
    }
    if (res.status === 429 || res.status === 503) {
      return { items, captcha: true, failed: false, errorDetail: `Bing HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { items, captcha: false, failed: true, errorDetail: `Bing HTTP ${res.status}` };
    }

    const html = await res.text();
    const parsed = await callOffscreen({ type: 'PARSE_BING_HTML', html });
    if (!parsed.ok) {
      return { items, captcha: false, failed: true, errorDetail: parsed.error };
    }
    if (parsed.kind !== 'bing') {
      return { items, captcha: false, failed: true, errorDetail: 'unexpected offscreen response' };
    }
    if (parsed.isCaptcha) {
      return { items, captcha: true, failed: false, errorDetail: 'Bing CAPTCHA' };
    }

    const before = seen.size;
    for (const item of parsed.items) {
      try {
        const canonical = new URL(item.url).toString();
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        items.push(item);
      } catch {
        /* ignore */
      }
    }
    const newOnPage = seen.size - before;
    send(port, {
      type: 'SCAN_PROGRESS',
      page: page + 1,
      foundOnPage: newOnPage,
      totalUnique: seen.size,
      note: `Bing first=${first}`,
    });

    if (newOnPage === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) break;
    } else {
      consecutiveEmpty = 0;
    }
  }

  return { items, captcha: false, failed: false };
}

// ---------------------------------------------------------------------------
// Sitemap crawler
// ---------------------------------------------------------------------------

const MAX_SITEMAPS_PER_SCAN = 50;
const MAX_SITEMAP_DEPTH = 3;

async function fetchPossiblyGzipped(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  const isGzip = url.toLowerCase().endsWith('.gz') || ct.includes('gzip') || ct.includes('octet-stream');
  if (isGzip && res.body) {
    const ds = new DecompressionStream('gzip');
    const decompressed = res.body.pipeThrough(ds);
    return await new Response(decompressed).text();
  }
  return await res.text();
}

async function discoverSitemaps(siteOrigin: string, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  // 1) robots.txt
  try {
    const res = await fetch(`${siteOrigin}/robots.txt`, { signal });
    if (res.ok) {
      const txt = await res.text();
      out.push(...extractSitemapsFromRobots(txt));
    }
  } catch {
    /* ignore */
  }
  // 2) Common defaults
  for (const guess of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']) {
    if (!out.some((u) => u.endsWith(guess))) out.push(`${siteOrigin}${guess}`);
  }
  return out;
}

async function scanSitemapTree(
  port: chrome.runtime.Port,
  siteOrigin: string,
  signal: AbortSignal,
): Promise<{ urls: string[]; visited: number; errorDetail?: string }> {
  const initialMaps = await discoverSitemaps(siteOrigin, signal);
  const queue: { url: string; depth: number }[] = initialMaps.map((u) => ({ url: u, depth: 0 }));
  const visited = new Set<string>();
  const allUrls: string[] = [];
  const allUrlsSeen = new Set<string>();
  let lastError: string | undefined;

  while (queue.length > 0 && visited.size < MAX_SITEMAPS_PER_SCAN && !signal.aborted) {
    const next = queue.shift();
    if (!next) break;
    if (visited.has(next.url)) continue;
    if (next.depth > MAX_SITEMAP_DEPTH) continue;
    visited.add(next.url);

    let xml: string;
    try {
      xml = await fetchPossiblyGzipped(next.url, signal);
    } catch (e) {
      lastError = `${next.url}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }

    const parsed = await callOffscreen({ type: 'PARSE_SITEMAP_XML', xml });
    if (!parsed.ok) {
      lastError = `${next.url}: ${parsed.error}`;
      continue;
    }
    if (parsed.kind !== 'sitemap') {
      lastError = `${next.url}: unexpected offscreen kind`;
      continue;
    }

    let added = 0;
    for (const u of parsed.urls) {
      if (allUrlsSeen.has(u)) continue;
      allUrlsSeen.add(u);
      allUrls.push(u);
      added++;
    }
    for (const child of parsed.sitemapIndex) {
      if (!visited.has(child)) queue.push({ url: child, depth: next.depth + 1 });
    }

    send(port, {
      type: 'SCAN_PROGRESS',
      page: visited.size,
      foundOnPage: added,
      totalUnique: allUrlsSeen.size,
      note: `sitemap ${visited.size}/${visited.size + queue.length}`,
    });
  }

  return { urls: allUrls, visited: visited.size, errorDetail: lastError };
}

// ---------------------------------------------------------------------------
// Top-level scan dispatch
// ---------------------------------------------------------------------------

async function emitFinal(
  session: Session,
  items: LinkInfo[],
  extensions: string[],
  error?: { reason: ScanErrorReason; detail: string },
) {
  const filtered = filterAndDedup(items, extensions);
  // Mark items already in the library so the side panel can show a badge and
  // uncheck them by default — user can still opt to re-download.
  try {
    const known = await knownCanonicalUrls(filtered.map((it) => it.url));
    for (const it of filtered) {
      const canonical = canonicalizeUrl(it.url);
      if (canonical && known.has(canonical)) it.alreadyHave = true;
    }
  } catch (e) {
    console.warn('[MassDownload] dedup check failed:', e);
  }
  send(session.port, { type: 'SCAN_DONE', items: filtered });
  if (error) {
    send(session.port, { type: 'SCAN_ERROR', reason: error.reason, detail: error.detail });
  }
  session.scanAbort = null;
}

async function scanFromTab(
  session: Session,
  tabUrl: string,
  tabId: number,
  extensions: string[],
  maxPages: number,
): Promise<void> {
  const ac = new AbortController();
  session.scanAbort = ac;

  if (isGoogleSearchUrl(tabUrl)) {
    send(session.port, { type: 'SCAN_STARTED', mode: 'google' });
    // Use the user's own tab — no duplicate. We won't close it on success.
    const result = await scanGoogleViaTab(
      session.port,
      session,
      { tabId, ownTab: false },
      tabUrl,
      ac.signal,
      maxPages,
    );
    if (ac.signal.aborted) {
      send(session.port, { type: 'STOPPED' });
      session.scanAbort = null;
      return;
    }
    if (result.captcha) {
      emitFinal(session, result.items, extensions, { reason: 'CAPTCHA', detail: result.errorDetail ?? 'CAPTCHA' });
      return;
    }
    if (result.failed) {
      emitFinal(session, result.items, extensions, { reason: 'NETWORK', detail: result.errorDetail ?? 'failed' });
      return;
    }
    emitFinal(session, result.items, extensions);
    return;
  }

  // Generic page mode — inject a tiny extractor in the active tab
  send(session.port, { type: 'SCAN_STARTED', mode: 'generic' });
  let scriptResults: chrome.scripting.InjectionResult<string[]>[];
  try {
    scriptResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
        const out: string[] = [];
        for (const a of Array.from(anchors)) {
          const href = a.href;
          if (!href || !/^https?:/i.test(href)) continue;
          out.push(href);
        }
        return out;
      },
    });
  } catch (e) {
    emitFinal(session, [], extensions, { reason: 'NETWORK', detail: e instanceof Error ? e.message : String(e) });
    return;
  }
  const allLinks: LinkInfo[] = [];
  for (const r of scriptResults) {
    if (Array.isArray(r.result)) for (const url of r.result) allLinks.push({ url });
  }
  send(session.port, { type: 'SCAN_PROGRESS', page: 1, foundOnPage: allLinks.length, totalUnique: allLinks.length });
  emitFinal(session, allLinks, extensions);
}

async function scanFromQuery(
  session: Session,
  query: SearchQuery,
  source: SearchSource,
  extensions: string[],
  maxPages: number,
): Promise<void> {
  const ac = new AbortController();
  session.scanAbort = ac;

  if (source === 'sitemap') {
    if (!query.site) {
      emitFinal(session, [], extensions, { reason: 'UNKNOWN', detail: 'site is required for sitemap mode' });
      return;
    }
    const origin = buildSiteOrigin(query.site);
    if (!origin) {
      emitFinal(session, [], extensions, { reason: 'UNKNOWN', detail: 'invalid site' });
      return;
    }
    send(session.port, { type: 'SCAN_STARTED', mode: 'sitemap' });
    const { urls, errorDetail } = await scanSitemapTree(session.port, origin, ac.signal);
    if (ac.signal.aborted) {
      send(session.port, { type: 'STOPPED' });
      session.scanAbort = null;
      return;
    }
    const items: LinkInfo[] = urls.map((url) => ({ url }));
    if (errorDetail && items.length === 0) {
      emitFinal(session, items, extensions, { reason: 'NETWORK', detail: errorDetail });
      return;
    }
    emitFinal(session, items, extensions);
    return;
  }

  if (source === 'bing') {
    send(session.port, { type: 'SCAN_STARTED', mode: 'bing' });
    const url = buildBingQueryUrl(query);
    const result = await scanBingSerp(session.port, url, ac.signal, maxPages);
    if (ac.signal.aborted) {
      send(session.port, { type: 'STOPPED' });
      session.scanAbort = null;
      return;
    }
    if (result.captcha) {
      emitFinal(session, result.items, extensions, { reason: 'CAPTCHA', detail: result.errorDetail ?? '' });
      return;
    }
    if (result.failed) {
      emitFinal(session, result.items, extensions, { reason: 'NETWORK', detail: result.errorDetail ?? '' });
      return;
    }
    emitFinal(session, result.items, extensions);
    return;
  }

  // Google with auto-fallback to Bing on CAPTCHA
  send(session.port, { type: 'SCAN_STARTED', mode: 'google' });
  const googleUrl = buildGoogleQueryUrl(query);
  // Reuse leftover scan tab from previous CAPTCHA if still around — prevents stacking.
  let scanTab: ScanTabSpec;
  try {
    scanTab = await acquireOwnedScanTab(session);
  } catch (e) {
    emitFinal(session, [], extensions, {
      reason: 'UNKNOWN',
      detail: `Could not open scan tab: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }
  const gResult = await scanGoogleViaTab(session.port, session, scanTab, googleUrl, ac.signal, maxPages);
  if (ac.signal.aborted) {
    send(session.port, { type: 'STOPPED' });
    session.scanAbort = null;
    return;
  }

  if (gResult.captcha) {
    // Auto-fallback to Bing — emit progress note so the user understands what's happening
    send(session.port, {
      type: 'SCAN_PROGRESS',
      page: 0,
      foundOnPage: 0,
      totalUnique: gResult.items.length,
      note: 'Google CAPTCHA — falling back to Bing',
    });
    send(session.port, { type: 'SCAN_STARTED', mode: 'bing' });
    const bingUrl = buildBingQueryUrl(query);
    const bResult = await scanBingSerp(session.port, bingUrl, ac.signal, maxPages);
    if (ac.signal.aborted) {
      send(session.port, { type: 'STOPPED' });
      session.scanAbort = null;
      return;
    }
    // Merge Google's partial items with Bing's items
    const merged: LinkInfo[] = [...gResult.items];
    const seen = new Set(merged.map((it) => it.url));
    for (const item of bResult.items) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    }
    if (bResult.failed || bResult.captcha) {
      emitFinal(session, merged, extensions, {
        reason: 'CAPTCHA',
        detail: `Google: ${gResult.errorDetail}; Bing: ${bResult.errorDetail ?? ''}`,
      });
      return;
    }
    emitFinal(session, merged, extensions);
    return;
  }
  if (gResult.failed) {
    emitFinal(session, gResult.items, extensions, { reason: 'NETWORK', detail: gResult.errorDetail ?? '' });
    return;
  }
  emitFinal(session, gResult.items, extensions);
}

// ---------------------------------------------------------------------------
// Library HTML write — base64 data URL (Service Worker can't use Blob URLs)
// ---------------------------------------------------------------------------

function htmlToDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html);
  let binary = '';
  // chunked to avoid call-stack overflow on very large strings
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`;
}

async function saveLibraryHtmlForHost(host: string): Promise<void> {
  const entries = await getEntries(host);
  if (entries.length === 0) return;
  const html = generateLibraryHtml(host, entries);
  const url = htmlToDataUrl(html);
  const filename = `MassDownload/${host}/library.html`;
  await new Promise<void>((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'overwrite', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'download failed'));
          return;
        }
        // Wait briefly for completion, then remove from chrome://downloads history
        // (the file stays on disk; we just don't pollute the user's download list).
        const onChanged = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== id) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.downloads.erase({ id }, () => resolve());
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error?.current ?? 'interrupted'));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      },
    );
  });
}

async function regenerateLibrariesForHosts(hosts: Iterable<string>): Promise<void> {
  for (const host of hosts) {
    try {
      await saveLibraryHtmlForHost(host);
    } catch (e) {
      console.error(`[MassDownload] could not save library for ${host}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Port handlers
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'massdownload') return;

  const session: Session = { port, scanAbort: null, downloader: null, scanTabId: null };
  sessions.add(session);

  port.onDisconnect.addListener(() => {
    session.scanAbort?.abort();
    session.downloader?.stop();
    sessions.delete(session);
  });

  port.onMessage.addListener(async (msg: SidepanelMsg) => {
    try {
      switch (msg.type) {
        case 'PING':
          send(port, { type: 'PONG' });
          break;
        case 'START_SCAN_TAB': {
          // Abort any previous scan instead of refusing — user expectation: re-scan replaces previous
          session.scanAbort?.abort();
          session.scanAbort = null;
          await scanFromTab(session, msg.tabUrl, msg.tabId, msg.extensions, msg.maxPages);
          break;
        }
        case 'START_SCAN_QUERY': {
          session.scanAbort?.abort();
          session.scanAbort = null;
          await scanFromQuery(session, msg.query, msg.source, msg.extensions, msg.maxPages);
          break;
        }
        case 'START_DOWNLOAD': {
          if (session.downloader) {
            send(port, { type: 'SCAN_ERROR', reason: 'UNKNOWN', detail: 'A download queue is already running' });
            return;
          }
          const handle = startQueue({
            items: msg.items,
            maxParallel: msg.maxParallel,
            subfolderPattern: msg.subfolderPattern,
            query: msg.query,
            source: msg.source,
            onItem: (item) => send(port, { type: 'DOWNLOAD_PROGRESS', item }),
          });
          session.downloader = handle;
          const result = await handle.done;
          session.downloader = null;

          // Persist new entries to the library and regenerate per-host HTML.
          if (result.newEntries.length) {
            try {
              await addEntries(result.newEntries);
              await regenerateLibrariesForHosts(result.affectedHosts);
            } catch (e) {
              console.error('[MassDownload] library update failed:', e);
            }
          }

          send(port, {
            type: 'DOWNLOAD_DONE',
            ok: result.ok,
            failed: result.failed,
            cancelled: result.cancelled,
          });
          break;
        }
        case 'STOP': {
          session.scanAbort?.abort();
          await session.downloader?.stop();
          send(port, { type: 'STOPPED' });
          break;
        }
      }
    } catch (e) {
      // CRITICAL: clear stuck state so subsequent scans aren't blocked
      session.scanAbort = null;
      session.downloader = null;
      send(port, {
        type: 'SCAN_ERROR',
        reason: 'UNKNOWN',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
});
