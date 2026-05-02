import type { LinkInfo } from '../types';

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
];

export function canonicalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    const entries = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of entries) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Returns true if the URL appears to point to a file with one of the target extensions.
 */
export function matchesExtension(url: string, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  const exts = extensions.map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (exts.length === 0) return true;
  const pattern = new RegExp(`\\.(${exts.join('|')})(?:$|[?#])`, 'i');
  try {
    const u = new URL(url);
    if (pattern.test(u.pathname)) return true;
    return pattern.test(u.search);
  } catch {
    return false;
  }
}

/** Sanitize a string for safe use as a Windows + cross-platform filename. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/, '')
      .replace(/^\.+/, '')
      .trim() || 'download'
  );
}

/** Derive an extension (without dot) from a URL, or '' if none found. */
export function extensionFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m?.[1]) return m[1].toLowerCase();
    const m2 = (u.pathname + u.search).match(/\.([a-z0-9]{2,5})\b/i);
    if (m2?.[1]) return m2[1].toLowerCase();
    return '';
  } catch {
    return '';
  }
}

/** Derive a filename from a URL alone (no title context). */
export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const decoded = decodeURIComponent(last);
    return sanitizeFilename(decoded || u.hostname);
  } catch {
    return 'download';
  }
}

/**
 * Smart filename: prefer the search-result title, append the URL's extension if missing.
 * Falls back to `filenameFromUrl` when no title is available.
 */
export function deriveFilename(item: LinkInfo): string {
  const ext = extensionFromUrl(item.url);
  if (item.title && item.title.trim()) {
    const sanitized = sanitizeFilename(item.title);
    if (ext && !new RegExp(`\\.${ext}$`, 'i').test(sanitized)) {
      return `${sanitized}.${ext}`;
    }
    return sanitized;
  }
  return filenameFromUrl(item.url);
}

/** Filter + dedup a list of candidate links. Preserves titles when present. */
export function filterAndDedup(items: LinkInfo[], extensions: string[]): LinkInfo[] {
  const seen = new Set<string>();
  const out: LinkInfo[] = [];
  for (const item of items) {
    if (!matchesExtension(item.url, extensions)) continue;
    const key = canonicalizeUrl(item.url);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
