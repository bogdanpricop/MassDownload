import type { LibraryEntry } from '../types';
import { canonicalizeUrl } from '../parsers/filters';

/**
 * Library manifest stored in `chrome.storage.local` keyed by canonical URL.
 *
 * - Source of truth for what we've already downloaded (used for scan-time dedup).
 * - Source of truth for the per-host `library.html` view (which is regenerated on
 *   demand from these entries, never read back).
 *
 * Storage shape: `{ library: { [canonical]: LibraryEntry, ... } }`
 *
 * O(1) lookup by canonical URL. For ~10k entries this is well within the 10MB
 * storage quota (each entry ≈ 500 bytes JSON).
 */

const STORAGE_KEY = 'library';

type LibraryMap = Record<string, LibraryEntry>;

async function loadRaw(): Promise<LibraryMap> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as LibraryMap | undefined) ?? {};
}

async function saveRaw(map: LibraryMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

/** Add or replace an entry. The id is its canonical URL. */
export async function addEntry(entry: LibraryEntry): Promise<void> {
  const map = await loadRaw();
  map[entry.id] = entry;
  await saveRaw(map);
}

/** Add multiple entries in a single storage write (faster than addEntry in a loop). */
export async function addEntries(entries: LibraryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const map = await loadRaw();
  for (const e of entries) map[e.id] = e;
  await saveRaw(map);
}

/** Returns true if a URL is already in the library (matched canonically). */
export async function hasUrl(url: string): Promise<boolean> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return false;
  const map = await loadRaw();
  return canonical in map;
}

/** Bulk dedup check — returns the set of canonical URLs that are already in the library. */
export async function knownCanonicalUrls(urls: string[]): Promise<Set<string>> {
  const map = await loadRaw();
  const out = new Set<string>();
  for (const url of urls) {
    const canonical = canonicalizeUrl(url);
    if (canonical && canonical in map) out.add(canonical);
  }
  return out;
}

/** Get all entries, optionally filtered by host. Sorted by downloadedAt desc. */
export async function getEntries(host?: string): Promise<LibraryEntry[]> {
  const map = await loadRaw();
  const all = Object.values(map);
  const filtered = host ? all.filter((e) => e.host === host) : all;
  return filtered.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

/** Group all entries by host, sorted within each group by downloadedAt desc. */
export async function getEntriesByHost(): Promise<Map<string, LibraryEntry[]>> {
  const all = await getEntries();
  const groups = new Map<string, LibraryEntry[]>();
  for (const e of all) {
    const arr = groups.get(e.host) ?? [];
    arr.push(e);
    groups.set(e.host, arr);
  }
  return groups;
}

/** Stats useful for the side panel header. */
export async function getStats(): Promise<{ total: number; hosts: number }> {
  const map = await loadRaw();
  const all = Object.values(map);
  const hosts = new Set(all.map((e) => e.host));
  return { total: all.length, hosts: hosts.size };
}

/** Remove an entry by canonical URL (used when user deletes from the library UI later). */
export async function removeEntry(id: string): Promise<boolean> {
  const map = await loadRaw();
  if (!(id in map)) return false;
  delete map[id];
  await saveRaw(map);
  return true;
}

/** Wipe the entire library (used for a "reset" action). */
export async function clearLibrary(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
