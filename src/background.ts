import { buildGooglePageUrl, isGoogleSearchUrl } from './parsers/google';
import { buildBingPageUrl } from './parsers/bing';
import { buildBingQueryUrl, buildGoogleQueryUrl, buildSiteOrigin } from './parsers/queryBuilder';
import { extractSitemapsFromRobots } from './parsers/sitemap';
import { canonicalizeUrl, filterAndDedup } from './parsers/filters';
import { startQueue, type DownloaderHandle } from './downloader';
import {
  addEntries,
  getEntries,
  knownCanonicalUrls,
  removeEntry,
  updateEntry,
} from './library/manifest';
import { generateLibraryHtml } from './library/htmlGenerator';
import {
  clearQueueState,
  loadQueueState,
  pendingItems,
  saveQueueState,
  type PersistedQueue,
} from './queueState';
import { findScheduledSearch, reconcileAlarms, recordScheduledRun } from './scheduler';
import { loadSettings } from './storage';
import { callParser } from './parseHost';
import type {
  BackgroundMsg,
  LibraryRequest,
  LibraryResponse,
  SidepanelMsg,
} from './messages';
import type { LinkInfo, ScanErrorReason, SearchQuery, SearchSource } from './types';


chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[MassDownload] setPanelBehavior failed:', e));
  void reconcileAlarms();
});

// Re-run reconciliation on SW startup so alarms survive eviction even if
// onInstalled doesn't fire.
chrome.runtime.onStartup.addListener(() => {
  void reconcileAlarms();
});

// DOM/XML parsing is delegated to a host-aware abstraction in src/parseHost.ts:
// Chromium uses an offscreen document; Firefox parses inline in the SW/event-page.
// (See callParser usages below.)

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
    const parsed = await callParser({ type: 'PARSE_BING_HTML', html });
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
// BFS site crawler
// ---------------------------------------------------------------------------

const CRAWL_MAX_DEPTH = 2;
const CRAWL_MAX_PAGES = 100;
const CRAWL_TIMEOUT_PER_PAGE_MS = 8000;

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname;
  } catch {
    return false;
  }
}

function looksLikeHtml(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Skip obvious binary asset extensions to avoid wasting fetches.
    return !/\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|eot|otf|mp[34]|mov|avi|zip|tar|gz|rar|7z|pdf|docx?|xlsx?|pptx?|epub)(\?|$)/i.test(path);
  } catch {
    return false;
  }
}

interface CrawlResult {
  items: LinkInfo[];
  visited: number;
  errorDetail?: string;
}

async function scanCrawl(
  port: chrome.runtime.Port,
  siteOrigin: string,
  signal: AbortSignal,
  extensions: string[],
): Promise<CrawlResult> {
  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: siteOrigin, depth: 0 }];
  const found = new Map<string, LinkInfo>();
  let lastError: string | undefined;

  // Pre-build extension matcher for early discard.
  const extPattern =
    extensions.length === 0
      ? null
      : new RegExp(`\\.(${extensions.map((e) => e.replace(/^\./, '').toLowerCase()).join('|')})(?:$|[?#])`, 'i');

  while (queue.length > 0 && visited.size < CRAWL_MAX_PAGES && !signal.aborted) {
    const next = queue.shift();
    if (!next) break;
    if (visited.has(next.url)) continue;
    if (next.depth > CRAWL_MAX_DEPTH) continue;
    visited.add(next.url);

    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), CRAWL_TIMEOUT_PER_PAGE_MS);

    let html = '';
    try {
      const res = await fetch(next.url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) {
        lastError = `${next.url}: HTTP ${res.status}`;
        continue;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/.test(ct)) continue;
      html = await res.text();
    } catch (e) {
      if (signal.aborted) break;
      lastError = `${next.url}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }

    const parsed = await callParser({ type: 'PARSE_PAGE_ANCHORS', html, baseUrl: next.url });
    if (!parsed.ok || parsed.kind !== 'page-anchors') {
      lastError = `${next.url}: ${parsed.ok ? 'wrong kind' : parsed.error}`;
      continue;
    }

    let newFiles = 0;
    for (const a of parsed.anchors) {
      if (!sameOrigin(a.url, siteOrigin)) continue; // intra-domain only
      if (extPattern && extPattern.test(a.url)) {
        // It's a target file
        if (!found.has(a.url)) {
          found.set(a.url, { url: a.url, title: a.text });
          newFiles++;
        }
      } else if (looksLikeHtml(a.url) && !visited.has(a.url) && next.depth + 1 <= CRAWL_MAX_DEPTH) {
        // It's another page to explore
        queue.push({ url: a.url, depth: next.depth + 1 });
      }
    }

    send(port, {
      type: 'SCAN_PROGRESS',
      page: visited.size,
      foundOnPage: newFiles,
      totalUnique: found.size,
      note: `crawl depth ${next.depth} (${visited.size}/${CRAWL_MAX_PAGES} pages)`,
    });
  }

  return { items: [...found.values()], visited: visited.size, errorDetail: lastError };
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

    const parsed = await callParser({ type: 'PARSE_SITEMAP_XML', xml });
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

  if (source === 'crawl') {
    if (!query.site) {
      await emitFinal(session, [], extensions, { reason: 'UNKNOWN', detail: 'site is required for crawl mode' });
      return;
    }
    const origin = buildSiteOrigin(query.site);
    if (!origin) {
      await emitFinal(session, [], extensions, { reason: 'UNKNOWN', detail: 'invalid site' });
      return;
    }
    send(session.port, { type: 'SCAN_STARTED', mode: 'sitemap' });
    const { items, errorDetail } = await scanCrawl(session.port, origin, ac.signal, extensions);
    if (ac.signal.aborted) {
      send(session.port, { type: 'STOPPED' });
      session.scanAbort = null;
      return;
    }
    if (errorDetail && items.length === 0) {
      await emitFinal(session, items, extensions, { reason: 'NETWORK', detail: errorDetail });
      return;
    }
    await emitFinal(session, items, extensions);
    return;
  }

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
// Resumable download queue runner
// ---------------------------------------------------------------------------

interface QueueRunOpts {
  items: import('./types').LinkInfo[];
  maxParallel: number;
  subfolderPattern: string;
  query?: string;
  source: import('./types').SearchSource | 'tab' | 'generic';
  preflightCheck?: boolean;
  startedAt: number;
  completedIds: string[];
}

async function runDownloadQueue(session: Session, opts: QueueRunOpts): Promise<void> {
  // Persist initial snapshot so a SW eviction mid-queue doesn't lose work.
  const persisted: PersistedQueue = {
    items: opts.items,
    completedIds: [...opts.completedIds],
    maxParallel: opts.maxParallel,
    subfolderPattern: opts.subfolderPattern,
    query: opts.query,
    source: opts.source,
    preflightCheck: opts.preflightCheck,
    startedAt: opts.startedAt,
  };
  await saveQueueState(persisted);

  // Throttle storage writes — every 5 settled items we flush completedIds.
  let dirty = 0;
  const flush = async () => {
    if (dirty === 0) return;
    dirty = 0;
    await saveQueueState(persisted);
  };

  const handle = startQueue({
    items: opts.items,
    maxParallel: opts.maxParallel,
    subfolderPattern: opts.subfolderPattern,
    query: opts.query,
    source: opts.source,
    preflightCheck: opts.preflightCheck,
    onItem: (item) => send(session.port, { type: 'DOWNLOAD_PROGRESS', item }),
    onItemSettled: (link, status) => {
      // Cancelled items remain pending so the user can resume them.
      if (status === 'cancelled') return;
      const id = canonicalizeUrl(link.url);
      if (id) persisted.completedIds.push(id);
      dirty++;
      if (dirty >= 5) {
        // Fire-and-forget; no need to await per-item.
        void flush();
      }
    },
  });
  session.downloader = handle;
  const result = await handle.done;
  session.downloader = null;
  await flush();

  if (result.newEntries.length) {
    try {
      await addEntries(result.newEntries);
      await regenerateLibrariesForHosts(result.affectedHosts);
    } catch (e) {
      console.error('[MassDownload] library update failed:', e);
    }
  }

  // Cancelled means the user hit Stop — keep the snapshot for a future Resume.
  // Otherwise (done/failed/skipped only): clear the persisted state.
  if (result.cancelled === 0) {
    await clearQueueState();
  } else {
    await flush();
  }

  send(session.port, {
    type: 'DOWNLOAD_DONE',
    ok: result.ok,
    failed: result.failed,
    cancelled: result.cancelled,
    skipped: result.skipped,
  });
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

  // If there's a leftover queue from a previous SW lifetime, surface it once.
  void (async () => {
    try {
      const persisted = await loadQueueState();
      if (!persisted) return;
      // Don't surface if a download is already running in this session.
      if (session.downloader) return;
      const pending = pendingItems(persisted);
      if (pending.length === 0) {
        await clearQueueState();
        return;
      }
      send(port, {
        type: 'QUEUE_RESUMABLE',
        pendingCount: pending.length,
        totalCount: persisted.items.length,
        startedAt: persisted.startedAt,
      });
    } catch (e) {
      console.warn('[MassDownload] resume check failed:', e);
    }
  })();

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
          await runDownloadQueue(session, {
            items: msg.items,
            maxParallel: msg.maxParallel,
            subfolderPattern: msg.subfolderPattern,
            query: msg.query,
            source: msg.source,
            preflightCheck: msg.preflightCheck,
            startedAt: Date.now(),
            completedIds: [],
          });
          break;
        }
        case 'RESUME_QUEUE': {
          if (session.downloader) {
            send(port, { type: 'SCAN_ERROR', reason: 'UNKNOWN', detail: 'A download queue is already running' });
            return;
          }
          const persisted = await loadQueueState();
          if (!persisted) return;
          const remaining = pendingItems(persisted);
          if (remaining.length === 0) {
            await clearQueueState();
            return;
          }
          // Reset items to only the pending ones; keep the same start time and
          // existing completedIds list so we don't double-count.
          await runDownloadQueue(session, {
            items: remaining,
            maxParallel: persisted.maxParallel,
            subfolderPattern: persisted.subfolderPattern,
            query: persisted.query,
            source: persisted.source,
            preflightCheck: persisted.preflightCheck,
            startedAt: persisted.startedAt,
            completedIds: persisted.completedIds,
          });
          break;
        }
        case 'DISCARD_QUEUE': {
          await clearQueueState();
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

// ---------------------------------------------------------------------------
// Scheduler: alarm-driven re-scans of saved searches
// ---------------------------------------------------------------------------

/**
 * Run a saved search headlessly, download new files only, optionally notify.
 * The scan results pass through the same dedup-by-library logic so already-
 * downloaded items don't get re-fetched.
 */
async function runScheduledScan(searchId: string): Promise<void> {
  const search = await findScheduledSearch(`massdl-search:${searchId}`);
  if (!search?.schedule) return;

  // Build a synthetic session backed by a no-op port. The scan helpers expect a
  // chrome.runtime.Port for SCAN_PROGRESS/SCAN_DONE — we satisfy them with a
  // shim that swallows postMessage. The download path uses session.downloader.
  const noopPort = {
    postMessage: () => undefined,
    disconnect: () => undefined,
    name: 'massdl-scheduler',
    onMessage: { addListener: () => undefined, removeListener: () => undefined } as never,
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined } as never,
  } as unknown as chrome.runtime.Port;

  const session: Session = {
    port: noopPort,
    scanAbort: null,
    downloader: null,
    scanTabId: null,
  };

  // Capture SCAN_DONE items from the noop port via a wrapper.
  let scanItems: import('./types').LinkInfo[] | null = null;
  const origPostMessage = noopPort.postMessage;
  (noopPort as { postMessage: (m: BackgroundMsg) => void }).postMessage = (m: BackgroundMsg) => {
    if (m.type === 'SCAN_DONE') scanItems = m.items;
    return (origPostMessage as () => void)();
  };

  try {
    const settings = await loadSettings();
    const extensions = search.query.filetypes ?? settings.targetExtensions;
    await scanFromQuery(session, search.query, search.source, extensions, settings.maxPages);

    // Filter to items that are NEW (not already in the library).
    const items: import('./types').LinkInfo[] = scanItems ?? [];
    const newItems = items.filter((it) => !it.alreadyHave);
    if (newItems.length === 0) {
      await recordScheduledRun(searchId);
      return;
    }

    // Run download queue with library integration. We don't need to surface
    // progress messages — there's no UI subscriber.
    const handle = startQueue({
      items: newItems,
      maxParallel: settings.maxParallel,
      subfolderPattern: settings.subfolderPattern,
      query: `[scheduled] ${search.label}`,
      source: search.source,
      preflightCheck: settings.preflightCheck,
      onItem: () => undefined,
    });
    const result = await handle.done;

    if (result.newEntries.length) {
      await addEntries(result.newEntries);
      await regenerateLibrariesForHosts(result.affectedHosts);
    }

    if (search.schedule.notify && result.ok > 0) {
      try {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: 'MassDownload — new files',
          message: `"${search.label}": ${result.ok} new file${result.ok === 1 ? '' : 's'} downloaded.`,
          priority: 1,
        });
      } catch {
        // Notification icon may not exist; degrade silently.
      }
    }

    await recordScheduledRun(searchId);
  } catch (e) {
    console.error('[MassDownload] scheduled run failed:', e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('massdl-search:')) return;
  const id = alarm.name.slice('massdl-search:'.length);
  void runScheduledScan(id);
});

// Re-reconcile whenever saved searches change (storage observer is cheaper than
// requiring every CRUD path to call reconcileAlarms manually).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!('settings' in changes)) return;
  void reconcileAlarms();
});

// ---------------------------------------------------------------------------
// In-extension library page API (one-shot sendMessage requests)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only handle messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id) return;
  // Library API messages have a `type` starting with LIBRARY_
  const m = msg as LibraryRequest & { type?: string };
  if (!m || typeof m !== 'object' || !m.type || !m.type.startsWith('LIBRARY_')) return;

  void (async () => {
    try {
      let response: LibraryResponse;
      switch (m.type) {
        case 'LIBRARY_LIST': {
          const list = await getEntries(m.host);
          response = { ok: true, entries: list };
          break;
        }
        case 'LIBRARY_UPDATE_ENTRY': {
          const entry = await updateEntry(m.id, m.patch);
          // Regenerate the on-disk HTML for this entry's host so it reflects edits.
          if (entry) {
            try {
              await saveLibraryHtmlForHost(entry.host);
            } catch (e) {
              console.warn('[MassDownload] regen after update failed:', e);
            }
          }
          response = { ok: true, entry };
          break;
        }
        case 'LIBRARY_REMOVE_ENTRY': {
          // Look up the host before removing so we can regen its HTML.
          const map = await getEntries();
          const target = map.find((e) => e.id === m.id);
          const removed = await removeEntry(m.id);
          if (removed && target) {
            try {
              await saveLibraryHtmlForHost(target.host);
            } catch (e) {
              console.warn('[MassDownload] regen after remove failed:', e);
            }
          }
          response = { ok: true };
          break;
        }
        case 'LIBRARY_REGENERATE_DISK_HTML': {
          await saveLibraryHtmlForHost(m.host);
          response = { ok: true };
          break;
        }
        default:
          response = { ok: false, error: 'unknown library request' };
      }
      sendResponse(response);
    } catch (e) {
      const errResp: LibraryResponse = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
      sendResponse(errResp);
    }
  })();

  return true; // keep the channel open for async sendResponse
});
