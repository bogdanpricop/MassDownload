import type { DownloadItem, LibraryEntry, LinkInfo, ScanErrorReason, SearchQuery, SearchSource } from './types';

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
      /** Pre-flight HEAD check to skip 404s before queuing download. */
      preflightCheck?: boolean;
    }
  | { type: 'STOP' }
  | { type: 'PING' }
  /** Resume a previously-interrupted queue (uses persisted state). */
  | { type: 'RESUME_QUEUE' }
  /** Discard the persisted queue without resuming. */
  | { type: 'DISCARD_QUEUE' };

// From background → sidepanel
export type BackgroundMsg =
  | { type: 'SCAN_STARTED'; mode: 'google' | 'generic' | 'sitemap' | 'bing' }
  | { type: 'SCAN_PROGRESS'; page: number; foundOnPage: number; totalUnique: number; note?: string }
  | { type: 'SCAN_DONE'; items: LinkInfo[] }
  | { type: 'SCAN_ERROR'; reason: ScanErrorReason; detail?: string }
  | { type: 'DOWNLOAD_PROGRESS'; item: DownloadItem }
  | { type: 'DOWNLOAD_DONE'; ok: number; failed: number; cancelled: number; skipped: number }
  | { type: 'STOPPED' }
  | { type: 'PONG' }
  /** Emitted on side panel reconnect when there's a previously-interrupted queue
   *  to offer the user a "Resume?" prompt. */
  | { type: 'QUEUE_RESUMABLE'; pendingCount: number; totalCount: number; startedAt: number };

// Library page (in-extension, editable) ↔ background, request/response.
export type LibraryRequest =
  | { type: 'LIBRARY_LIST'; host?: string }
  | {
      type: 'LIBRARY_UPDATE_ENTRY';
      id: string;
      patch: Partial<Pick<LibraryEntry, 'customTitle' | 'tags' | 'notes'>>;
    }
  | { type: 'LIBRARY_REMOVE_ENTRY'; id: string }
  | { type: 'LIBRARY_REGENERATE_DISK_HTML'; host: string };

export type LibraryResponse =
  | { ok: true; entries: LibraryEntry[] }
  | { ok: true; entry: LibraryEntry | null }
  | { ok: true }
  | { ok: false; error: string };

// Offscreen document parses HTML/XML — request/response over chrome.runtime.sendMessage.
// Google scanning runs entirely in a real tab via `chrome.scripting.executeScript`,
// so it doesn't need offscreen.
export type OffscreenMsg =
  | { type: 'PARSE_BING_HTML'; html: string }
  | { type: 'PARSE_SITEMAP_XML'; xml: string }
  | { type: 'PARSE_PAGE_ANCHORS'; html: string; baseUrl: string };

export type OffscreenResponse =
  | { ok: true; kind: 'bing'; items: LinkInfo[]; isCaptcha: boolean }
  | { ok: true; kind: 'sitemap'; urls: string[]; sitemapIndex: string[] }
  | { ok: true; kind: 'page-anchors'; anchors: { url: string; text?: string }[] }
  | { ok: false; error: string };
