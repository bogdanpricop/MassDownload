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

/**
 * Apply a partial update to an existing entry. Used by the editable library
 * page for customTitle / tags / notes edits.
 *
 * Returns the updated entry, or null if no entry with this id exists.
 * Tags are normalized: trimmed, lowercased, deduplicated, empty filtered out.
 */
export async function updateEntry(
  id: string,
  patch: Partial<Pick<LibraryEntry, 'customTitle' | 'tags' | 'notes'>>,
): Promise<LibraryEntry | null> {
  const map = await loadRaw();
  const existing = map[id];
  if (!existing) return null;

  const next: LibraryEntry = { ...existing };
  if ('customTitle' in patch) {
    const v = patch.customTitle?.trim();
    if (v) next.customTitle = v;
    else delete next.customTitle;
  }
  if ('notes' in patch) {
    const v = patch.notes?.trim();
    if (v) next.notes = v;
    else delete next.notes;
  }
  if ('tags' in patch) {
    const cleaned = (patch.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const unique = [...new Set(cleaned)];
    if (unique.length) next.tags = unique;
    else delete next.tags;
  }

  map[id] = next;
  await saveRaw(map);
  return next;
}

/** Return all distinct tags across the library, sorted by frequency desc. */
export async function getAllTags(): Promise<{ tag: string; count: number }[]> {
  const map = await loadRaw();
  const counts = new Map<string, number>();
  for (const e of Object.values(map)) {
    if (!e.tags) continue;
    for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Wipe the entire library (used for a "reset" action). */
export async function clearLibrary(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
