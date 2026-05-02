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
