import { canonicalizeUrl, deriveFilename, extensionFromUrl, sanitizeFilename } from './parsers/filters';
import type { DownloadItem, LibraryEntry, LinkInfo, SearchSource } from './types';

export interface DownloaderResult {
  ok: number;
  failed: number;
  cancelled: number;
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
  onItem: (item: DownloadItem) => void;
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
  const { items, maxParallel, subfolderPattern, query, source, onItem } = opts;
  const ac = new AbortController();
  let cursor = 0;
  let okCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
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
      try {
        const result = await downloadOne(link, subfolderPattern, ac.signal);
        dl.downloadId = result.downloadId;
        dl.filename = result.downloadItem.filename.replace(/^.*[\\/]/, '');
        dl.status = 'done';
        okCount++;
        recordSuccess(link, result.downloadItem);
        onItem(dl);
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
