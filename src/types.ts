export type ItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';

/** A discovered downloadable link, optionally with a human-readable title. */
export interface LinkInfo {
  url: string;
  /** Title from search snippet — used as filename if present. */
  title?: string;
  /** Description / snippet text (the gray text under the title in Google/Bing results). */
  description?: string;
  /** Marked at scan-time dedup: true if already present in library (UI hint). */
  alreadyHave?: boolean;
}

export interface DownloadItem {
  url: string;
  filename: string;
  status: ItemStatus;
  downloadId?: number;
  error?: string;
  bytesReceived?: number;
  totalBytes?: number;
}

export type SearchSource = 'google' | 'sitemap' | 'bing';

export interface SearchQuery {
  /** Domain like `bej-cojocaru.ro` (without protocol). Optional but usually set. */
  site?: string;
  /** One or more file extensions (without dot). */
  filetypes?: string[];
  /** Free-text keywords appended to the query. */
  keywords?: string;
  /** Comma-separated terms to exclude (each prefixed with `-` in the query). */
  exclude?: string;
}

export interface SavedSearch {
  id: string;
  label: string;
  query: SearchQuery;
  source: SearchSource;
  createdAt: number;
}

export interface Settings {
  targetExtensions: string[];
  maxParallel: number;
  maxPages: number;
  subfolderPattern: string;
  savedSearches: SavedSearch[];
}

export const DEFAULT_SETTINGS: Settings = {
  targetExtensions: ['pdf'],
  maxParallel: 5,
  maxPages: 20,
  subfolderPattern: 'MassDownload/{host}',
  savedSearches: [],
};

export type ScanErrorReason = 'CAPTCHA' | 'NETWORK' | 'PARSE' | 'NO_TAB' | 'UNKNOWN';

/** A fully-tracked file in the library — source of truth in chrome.storage.local. */
export interface LibraryEntry {
  /** Canonical URL (lowercase host, sorted query, no fragment, no tracking params). Used as map key. */
  id: string;
  /** Original URL as discovered. */
  url: string;
  /** Basename of the saved file, e.g. "Decizia.pdf". */
  filename: string;
  /** Absolute filesystem path (from chrome.downloads). Used as `file://` link in library HTML. */
  localPath: string;
  /** Hostname like "bej-cojocaru.ro" (no www., lowercase). */
  host: string;
  title?: string;
  description?: string;
  /** Free-text query that found this file (e.g. "site:bej-cojocaru.ro filetype:pdf"). */
  query?: string;
  source: SearchSource | 'tab' | 'generic';
  extension: string;
  /** Unix ms when first seen in a scan. */
  discoveredAt: number;
  /** Unix ms when downloaded successfully. */
  downloadedAt: number;
  /** Chrome's internal download id (last successful download). */
  downloadId?: number;
  /** File size in bytes if known (from chrome.downloads). */
  size?: number;
}
