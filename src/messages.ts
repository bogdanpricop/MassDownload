import type { DownloadItem, LinkInfo, ScanErrorReason, SearchQuery, SearchSource } from './types';

// From sidepanel → background
export type SidepanelMsg =
  | {
      // Scan from the active tab (Google search if URL matches, generic otherwise)
      type: 'START_SCAN_TAB';
      tabUrl: string;
      tabId: number;
      extensions: string[];
      maxPages: number;
    }
  | {
      // Scan from a structured query (Google / Bing / sitemap), no Google tab needed
      type: 'START_SCAN_QUERY';
      query: SearchQuery;
      source: SearchSource;
      extensions: string[];
      maxPages: number;
    }
  | {
      type: 'START_DOWNLOAD';
      items: LinkInfo[];
      maxParallel: number;
      subfolderPattern: string;
      /** Free-text query that produced these items (stored as library metadata). */
      query?: string;
      /** Source engine / mode that produced these items. */
      source: SearchSource | 'tab' | 'generic';
    }
  | { type: 'STOP' }
  | { type: 'PING' };

// From background → sidepanel
export type BackgroundMsg =
  | { type: 'SCAN_STARTED'; mode: 'google' | 'generic' | 'sitemap' | 'bing' }
  | { type: 'SCAN_PROGRESS'; page: number; foundOnPage: number; totalUnique: number; note?: string }
  | { type: 'SCAN_DONE'; items: LinkInfo[] }
  | { type: 'SCAN_ERROR'; reason: ScanErrorReason; detail?: string }
  | { type: 'DOWNLOAD_PROGRESS'; item: DownloadItem }
  | { type: 'DOWNLOAD_DONE'; ok: number; failed: number; cancelled: number }
  | { type: 'STOPPED' }
  | { type: 'PONG' };

// Offscreen document parses HTML/XML — request/response over chrome.runtime.sendMessage.
// Google scanning runs entirely in a real tab via `chrome.scripting.executeScript`,
// so it doesn't need offscreen.
export type OffscreenMsg =
  | { type: 'PARSE_BING_HTML'; html: string }
  | { type: 'PARSE_SITEMAP_XML'; xml: string };

export type OffscreenResponse =
  | { ok: true; kind: 'bing'; items: LinkInfo[]; isCaptcha: boolean }
  | { ok: true; kind: 'sitemap'; urls: string[]; sitemapIndex: string[] }
  | { ok: false; error: string };
