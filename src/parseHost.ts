/**
 * Cross-browser DOM/XML parsing abstraction.
 *
 * Chromium (Chrome/Edge/Brave): service workers can't use `DOMParser`, so we
 * route through an offscreen document via `chrome.offscreen` and
 * `chrome.runtime.sendMessage`.
 *
 * Firefox: service workers (and event pages) can use `DOMParser` directly,
 * and `chrome.offscreen` doesn't exist. We detect this at runtime and parse
 * in-process.
 *
 * This module exposes a single `callParser(msg)` function that internally
 * picks the right path. All call sites stay browser-agnostic.
 */

import type { OffscreenMsg, OffscreenResponse } from './messages';
import { extractLinksFromBingDoc } from './parsers/bing';
import { extractFromSitemapDoc } from './parsers/sitemap';

const OFFSCREEN_PATH = 'src/offscreen.html';

/** True if the running browser exposes the offscreen API (Chrome/Edge MV3). */
function hasOffscreen(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.offscreen !== 'undefined';
}

/** True if `DOMParser` is callable from the current execution context. */
function hasInProcessDomParser(): boolean {
  return typeof DOMParser !== 'undefined';
}

// ---------------------------------------------------------------------------
// In-process parsing (Firefox path) — runs the same logic the offscreen
// document runs on Chromium, but inline.
// ---------------------------------------------------------------------------

function parseInProcess(msg: OffscreenMsg): OffscreenResponse {
  try {
    const parser = new DOMParser();
    if (msg.type === 'PARSE_BING_HTML') {
      const doc = parser.parseFromString(msg.html, 'text/html');
      const { items, isCaptcha } = extractLinksFromBingDoc(doc);
      return { ok: true, kind: 'bing', items, isCaptcha };
    }
    if (msg.type === 'PARSE_PAGE_ANCHORS') {
      const doc = parser.parseFromString(msg.html, 'text/html');
      const base = doc.createElement('base');
      base.href = msg.baseUrl;
      doc.head.prepend(base);
      const anchors: { url: string; text?: string }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href;
        if (!href || !/^https?:/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const text = a.textContent?.trim();
        anchors.push({ url: href, text: text || undefined });
      }
      return { ok: true, kind: 'page-anchors', anchors };
    }
    if (msg.type === 'PARSE_SITEMAP_XML') {
      const doc = parser.parseFromString(msg.xml, 'text/xml');
      const parserError = doc.querySelector('parsererror');
      if (parserError) {
        return { ok: false, error: `XML parse error: ${parserError.textContent?.slice(0, 200) ?? 'unknown'}` };
      }
      const { urls, sitemapIndex } = extractFromSitemapDoc(doc);
      return { ok: true, kind: 'sitemap', urls, sitemapIndex };
    }
    return { ok: false, error: 'unknown parser msg type' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Offscreen-document parsing (Chromium path) — same as before.
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
      justification: 'Parse Bing HTML, sitemap XML, and crawled page HTML with DOMParser.',
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

async function parseViaOffscreen(msg: OffscreenMsg): Promise<OffscreenResponse> {
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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse HTML or XML using the best available strategy for the current browser.
 *
 *  - Chromium MV3: routes via offscreen document (DOMParser unavailable in SW).
 *  - Firefox MV3: parses inline (DOMParser available in SW / event page).
 */
export async function callParser(msg: OffscreenMsg): Promise<OffscreenResponse> {
  if (hasInProcessDomParser()) {
    return parseInProcess(msg);
  }
  if (hasOffscreen()) {
    return parseViaOffscreen(msg);
  }
  return { ok: false, error: 'no DOM parser available in this environment' };
}
