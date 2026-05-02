import { canonicalizeUrl, deriveFilename, extensionFromUrl, sanitizeFilename } from './parsers/filters';
import type { DownloadItem, LibraryEntry, LinkInfo, SearchSource } from './types';

export interface DownloaderResult {
  ok: number;
  failed: number;
  cancelled: number;
  skipped: number;
  /** Library entries built for each successful download. The caller flushes
   *  these to the library + regenerates per-host HTML afterwards. */
  newEntries: LibraryEntry[];
  /** Hosts touched by this batch — used to know which library.html to regenerate. */
  affectedHosts: Set<string>;
}

export interface DownloaderHandle {
  done: Promise<DownloaderResult>;
  stop: () => Promise<void>;
}

interface QueueOpts {
  items: LinkInfo[];
  maxParallel: number;
  subfolderPattern: string;
  /** Free-text query that produced these items (for library metadata). */
  query?: string;
  /** Engine / mode that produced these items. */
  source: SearchSource | 'tab' | 'generic';
  /** When true, do a HEAD request first; skip 404/410 without consuming a download slot. */
  preflightCheck?: boolean;
  onItem: (item: DownloadItem) => void;
  /** Fires once an item reaches a terminal status (done/failed/skipped/cancelled).
   *  Used by background to keep a persisted resumable queue snapshot. */
  onItemSettled?: (link: LinkInfo, status: DownloadItem['status']) => void;
}

const PREFLIGHT_TIMEOUT_MS = 3000;

/**
 * Lightweight URL reachability probe. Returns 'skip' for definitive 404/410,
 * 'proceed' for everything else (including network errors / HEAD-rejecting servers).
 *
 * We deliberately don't fail the download just because HEAD failed — many servers
 * reject HEAD with 405 but accept GET. Only definitive "not found" status codes skip.
 */
async function preflightOne(url: string, signal: AbortSignal): Promise<'skip' | 'proceed'> {
  try {
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: ac.signal,
        cache: 'no-store',
      });
      if (res.status === 404 || res.status === 410) return 'skip';
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
  } catch {
    // network error / timeout / aborted — be permissive, let the actual download try.
  }
  return 'proceed';
}

function applySubfolder(pattern: string, url: string, name: string): string {
  if (!pattern) return name;
  let folder = pattern;
  try {
    const u = new URL(url);
    folder = folder.replace(/\{host\}/g, sanitizeFilename(u.hostname));
  } catch {
    folder = folder.replace(/\{host\}/g, 'unknown');
  }
  folder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/${name}` : name;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function waitForDownload(downloadId: number, signal: AbortSignal): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (results[0]) resolve(results[0]);
          else reject(new Error('completed but search returned no item'));
        });
      } else if (delta.state?.current === 'interrupted') {
        cleanup();
        reject(new Error(delta.error?.current ?? 'interrupted'));
      }
    };
    const onAbort = () => {
      cleanup();
      chrome.downloads.cancel(downloadId, () => {
        // ignore
      });
      reject(new Error('cancelled'));
    };
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      signal.removeEventListener('abort', onAbort);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function downloadOne(
  item: LinkInfo,
  subfolderPattern: string,
  signal: AbortSignal,
): Promise<{ downloadItem: chrome.downloads.DownloadItem; downloadId: number }> {
  const name = deriveFilename(item);
  const filename = applySubfolder(subfolderPattern, item.url, name);
  const downloadId = await new Promise<number>((resolve, reject) => {
    chrome.downloads.download(
      {
        url: item.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      },
      (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'download() returned no id'));
        } else {
          resolve(id);
        }
      },
    );
  });
  const downloadItem = await waitForDownload(downloadId, signal);
  return { downloadItem, downloadId };
}

function buildLibraryEntry(
  link: LinkInfo,
  download: chrome.downloads.DownloadItem,
  query: string | undefined,
  source: SearchSource | 'tab' | 'generic',
  now: number,
): LibraryEntry | null {
  const canonical = canonicalizeUrl(link.url);
  if (!canonical) return null;
  const localPath = download.filename; // absolute path per chrome.downloads docs
  const basename = localPath.replace(/^.*[\\/]/, '');
  return {
    id: canonical,
    url: link.url,
    filename: basename,
    localPath,
    host: hostOf(link.url),
    title: link.title,
    description: link.description,
    query,
    source,
    extension: extensionFromUrl(link.url),
    discoveredAt: now,
    downloadedAt: now,
    downloadId: download.id,
    size: download.fileSize > 0 ? download.fileSize : undefined,
  };
}

export function startQueue(opts: QueueOpts): DownloaderHandle {
  const { items, maxParallel, subfolderPattern, query, source, preflightCheck, onItem, onItemSettled } = opts;
  const ac = new AbortController();
  let cursor = 0;
  let okCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let skippedCount = 0;
  const newEntries: LibraryEntry[] = [];
  const affectedHosts = new Set<string>();

  const recordSuccess = (link: LinkInfo, download: chrome.downloads.DownloadItem) => {
    const entry = buildLibraryEntry(link, download, query, source, Date.now());
    if (entry) {
      newEntries.push(entry);
      affectedHosts.add(entry.host);
    }
  };

  const worker = async () => {
    while (cursor < items.length && !ac.signal.aborted) {
      const idx = cursor++;
      const link = items[idx];
      if (link === undefined) break;
      const dl: DownloadItem = {
        url: link.url,
        filename: deriveFilename(link),
        status: 'downloading',
      };
      onItem(dl);

      if (preflightCheck) {
        const verdict = await preflightOne(link.url, ac.signal);
        if (verdict === 'skip') {
          dl.status = 'skipped';
          dl.error = 'HEAD returned 404/410';
          skippedCount++;
          onItem(dl);
          onItemSettled?.(link, 'skipped');
          continue;
        }
        if (ac.signal.aborted) {
          dl.status = 'cancelled';
          cancelledCount++;
          onItem(dl);
          onItemSettled?.(link, 'cancelled');
          break;
        }
      }

      try {
        const result = await downloadOne(link, subfolderPattern, ac.signal);
        dl.downloadId = result.downloadId;
        dl.filename = result.downloadItem.filename.replace(/^.*[\\/]/, '');
        dl.status = 'done';
        okCount++;
        recordSuccess(link, result.downloadItem);
        onItem(dl);
        onItemSettled?.(link, 'done');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'cancelled' || ac.signal.aborted) {
          dl.status = 'cancelled';
          dl.error = msg;
          cancelledCount++;
        } else {
          if (/^NETWORK_/i.test(msg) && !ac.signal.aborted) {
            try {
              const result2 = await downloadOne(link, subfolderPattern, ac.signal);
              dl.downloadId = result2.downloadId;
              dl.filename = result2.downloadItem.filename.replace(/^.*[\\/]/, '');
              dl.status = 'done';
              okCount++;
              recordSuccess(link, result2.downloadItem);
              onItem(dl);
              onItemSettled?.(link, 'done');
              continue;
            } catch (e2) {
              dl.error = e2 instanceof Error ? e2.message : String(e2);
            }
          } else {
            dl.error = msg;
          }
          dl.status = 'failed';
          failedCount++;
        }
        onItem(dl);
        onItemSettled?.(link, dl.status);
      }
    }
  };

  const done = (async () => {
    const workers = Array.from({ length: Math.max(1, maxParallel) }, () => worker());
    await Promise.all(workers);
    return {
      ok: okCount,
      failed: failedCount,
      cancelled: cancelledCount,
      skipped: skippedCount,
      newEntries,
      affectedHosts,
    };
  })();

  return {
    done,
    stop: async () => {
      ac.abort();
    },
  };
}
