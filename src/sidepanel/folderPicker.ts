/**
 * One-shot subfolder picker built on top of `chrome.downloads`.
 *
 * Strategy:
 *  1. Probe the Downloads root by triggering a tiny `saveAs: false` download
 *     to a known relative path; Chrome reports back the absolute path, from
 *     which we derive the Downloads root.
 *  2. Open a real `saveAs: true` dialog with a placeholder filename. The user
 *     navigates to the desired folder and saves.
 *  3. Compute the subfolder path relative to the Downloads root.
 *  4. Clean up both probe files (removeFile + erase from history).
 *
 * Caveats:
 *  - If the user picks a folder OUTSIDE Downloads, we can't use it as a relative
 *    `filename` for subsequent downloads — Chrome rejects absolute paths in the
 *    download API. In that case we return null and the caller shows a warning.
 *  - If Chrome's "Ask where to save each file" setting is ON, the probe itself
 *    will prompt the user, breaking the heuristic. In that case the picker
 *    aborts cleanly and the caller asks the user to disable the setting.
 */

const PROBE_FILENAME = '.massdl-probe.tmp';
const PICK_FILENAME = '.massdl-folder-anchor.tmp';

interface DownloadResult {
  fullPath: string;
  id: number;
}

function startDownload(opts: chrome.downloads.DownloadOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'download failed'));
      } else {
        resolve(id);
      }
    });
  });
}

function waitForCompletion(downloadId: number): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.search({ id: downloadId }, (results) => {
          const fullPath = results[0]?.filename;
          if (fullPath) resolve({ fullPath, id: downloadId });
          else reject(new Error('download completed but path missing'));
        });
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(delta.error?.current ?? 'interrupted'));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function cleanup(id: number) {
  // Remove the file from disk if still there, then erase the entry from history.
  try {
    await new Promise<void>((resolve) => chrome.downloads.removeFile(id, () => resolve()));
  } catch {
    /* ignore */
  }
  try {
    await new Promise<void>((resolve) => chrome.downloads.erase({ id }, () => resolve()));
  } catch {
    /* ignore */
  }
}

function dirOf(fullPath: string): string {
  return fullPath.replace(/[\\/][^\\/]+$/, '');
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Detect the Downloads root via a silent probe. */
async function detectDownloadsRoot(): Promise<string> {
  const id = await startDownload({
    url: 'data:text/plain;base64,bWFzc2RsLXByb2Jl', // "massdl-probe"
    filename: PROBE_FILENAME,
    saveAs: false,
    conflictAction: 'overwrite',
  });
  try {
    const { fullPath } = await waitForCompletion(id);
    return dirOf(fullPath);
  } finally {
    await cleanup(id);
  }
}

export interface PickResult {
  /** Subfolder relative to Downloads, e.g. "MyDocs/Court" or "" for root. */
  subfolder: string;
}

/**
 * Open a Save-As dialog so the user can choose a target folder.
 * Returns the relative subfolder, or throws on cancel / outside-Downloads selection.
 */
export async function pickDownloadSubfolder(): Promise<PickResult> {
  const root = await detectDownloadsRoot();

  let id: number;
  try {
    id = await startDownload({
      url: 'data:text/plain;base64,bWFzc2RsLWFuY2hvcg==', // "massdl-anchor"
      filename: PICK_FILENAME,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    throw new Error(`Picker cancelled: ${e instanceof Error ? e.message : String(e)}`);
  }

  let chosenDir: string;
  try {
    const { fullPath } = await waitForCompletion(id);
    chosenDir = dirOf(fullPath);
  } catch (e) {
    await cleanup(id);
    throw new Error(`Picker cancelled: ${e instanceof Error ? e.message : String(e)}`);
  }
  await cleanup(id);

  const rootNorm = normalize(root).toLowerCase();
  const chosenNorm = normalize(chosenDir).toLowerCase();

  if (chosenNorm === rootNorm) return { subfolder: '' };
  if (chosenNorm.startsWith(rootNorm + '/')) {
    // Preserve original case from chosenDir (substring of fullPath, not lowercased)
    return { subfolder: normalize(chosenDir).slice(rootNorm.length + 1) };
  }
  throw new Error(
    `Folder must be inside ${root}. Chrome only lets extensions save to the Downloads tree.`,
  );
}
