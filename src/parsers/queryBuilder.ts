import type { SearchQuery } from '../types';

/**
 * Build the textual `q=` value for a search query.
 * Produces things like: `site:bej-cojocaru.ro filetype:pdf legea -inurl:archive`
 */
export function buildQueryString(q: SearchQuery): string {
  const parts: string[] = [];

  if (q.site) {
    const cleanSite = q.site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    if (cleanSite) parts.push(`site:${cleanSite}`);
  }

  if (q.filetypes && q.filetypes.length > 0) {
    const exts = q.filetypes.map((e) => e.replace(/^\./, '').trim().toLowerCase()).filter(Boolean);
    if (exts.length === 1) {
      parts.push(`filetype:${exts[0]}`);
    } else if (exts.length > 1) {
      // Note: Google's `filetype:` operator with OR; parens group it cleanly
      parts.push('(' + exts.map((e) => `filetype:${e}`).join(' OR ') + ')');
    }
  }

  if (q.keywords && q.keywords.trim()) {
    parts.push(q.keywords.trim());
  }

  if (q.exclude && q.exclude.trim()) {
    const excluded = q.exclude
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((term) => (term.startsWith('-') ? term : `-${term}`));
    if (excluded.length) parts.push(excluded.join(' '));
  }

  return parts.join(' ').trim();
}

/**
 * Build a Google search URL from a structured query.
 * NOTE: Google capped `num` to ~10 in late 2024 — values higher than 10 are
 * silently ignored. We always send `num=10` and paginate via `start`.
 */
export function buildGoogleQueryUrl(q: SearchQuery, start = 0): string {
  const u = new URL('https://www.google.com/search');
  u.searchParams.set('q', buildQueryString(q));
  u.searchParams.set('num', '10');
  u.searchParams.set('start', String(start));
  u.searchParams.set('filter', '0');
  u.searchParams.set('hl', 'en');
  return u.toString();
}

/** Build a Bing search URL from a structured query. */
export function buildBingQueryUrl(q: SearchQuery, count = 50, first = 1): string {
  const u = new URL('https://www.bing.com/search');
  u.searchParams.set('q', buildQueryString(q));
  u.searchParams.set('count', String(count));
  u.searchParams.set('first', String(first));
  return u.toString();
}

/** Construct a candidate origin URL for sitemap discovery. */
export function buildSiteOrigin(site: string): string | null {
  const cleaned = site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!cleaned) return null;
  return `https://${cleaned}`;
}

/** Generate a short label for a saved search, suitable for UI display. */
export function describeQuery(q: SearchQuery, source: string): string {
  const parts: string[] = [];
  if (q.site) parts.push(q.site);
  if (q.filetypes && q.filetypes.length) parts.push(`.${q.filetypes.join('/.')}`);
  if (q.keywords) parts.push(`"${q.keywords}"`);
  return `[${source}] ${parts.join(' ') || '(empty)'}`;
}
