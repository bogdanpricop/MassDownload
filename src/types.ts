export type ItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled' | 'skipped';

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

export type SearchSource = 'google' | 'sitemap' | 'bing' | 'crawl';

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
  /** Recurring re-scan schedule. When set, the extension wakes up every
   *  intervalDays and re-runs this search, auto-downloading any new files
   *  (already-in-library items are filtered out by the manifest dedup). */
  schedule?: {
    intervalDays: number;
    /** Unix ms of last successful run. */
    lastRunAt?: number;
    /** Unix ms when the next run is due. */
    nextRunAt?: number;
    /** When true, show a desktop notification on new files. */
    notify: boolean;
  };
}

export interface Settings {
  targetExtensions: string[];
  maxParallel: number;
  maxPages: number;
  subfolderPattern: string;
  savedSearches: SavedSearch[];
  /** When true, a HEAD request is made before each download. URLs that return 404/410
   *  are skipped without consuming a download slot. Useful for sitemap mode where
   *  many URLs may be stale. Default false (extra request per file). */
  preflightCheck: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  targetExtensions: ['pdf'],
  maxParallel: 5,
  maxPages: 20,
  subfolderPattern: 'MassDownload/{host}',
  savedSearches: [],
  preflightCheck: false,
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
  /** Title from search snippet at scan time (immutable record). */
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
  // ---- User-editable overlay (set via the in-extension library page) ----
  /** User-provided title; when set, displayed instead of `title` in views. */
  customTitle?: string;
  /** Tags assigned by the user (lowercase, deduplicated). */
  tags?: string[];
  /** Free-text notes the user has attached to this entry. */
  notes?: string;
}
