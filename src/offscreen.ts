import { extractLinksFromBingDoc } from './parsers/bing';
import { extractFromSitemapDoc } from './parsers/sitemap';
import type { OffscreenMsg, OffscreenResponse } from './messages';

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  try {
    const parser = new DOMParser();
    if (msg.type === 'PARSE_BING_HTML') {
      const doc = parser.parseFromString(msg.html, 'text/html');
      const { items, isCaptcha } = extractLinksFromBingDoc(doc);
      const response: OffscreenResponse = { ok: true, kind: 'bing', items, isCaptcha };
      sendResponse(response);
      return true;
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
      const response: OffscreenResponse = { ok: true, kind: 'page-anchors', anchors };
      sendResponse(response);
      return true;
    }
    if (msg.type === 'PARSE_SITEMAP_XML') {
      const doc = parser.parseFromString(msg.xml, 'text/xml');
      const parserError = doc.querySelector('parsererror');
      if (parserError) {
        const err: OffscreenResponse = {
          ok: false,
          error: `XML parse error: ${parserError.textContent?.slice(0, 200) ?? 'unknown'}`,
        };
        sendResponse(err);
        return true;
      }
      const { urls, sitemapIndex } = extractFromSitemapDoc(doc);
      const response: OffscreenResponse = { ok: true, kind: 'sitemap', urls, sitemapIndex };
      sendResponse(response);
      return true;
    }
    return; // not for us
  } catch (e) {
    const response: OffscreenResponse = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    sendResponse(response);
    return true;
  }
});
