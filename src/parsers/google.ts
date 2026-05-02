/**
 * Google SERP URL helpers used by the side panel and background.
 *
 * Note: link extraction itself runs INSIDE the Google tab via
 * `chrome.scripting.executeScript({ func })` — see `extractGoogleInPage` in
 * `background.ts`. The serialized function must be self-contained, which is why
 * the extraction logic isn't in this module.
 */

/** Build the Google search URL for a given page (start offset). Always uses num=10. */
export function buildGooglePageUrl(originalUrl: string, start: number): string {
  const u = new URL(originalUrl);
  u.searchParams.set('start', String(start));
  u.searchParams.set('num', '10');
  u.searchParams.set('filter', '0');
  return u.toString();
}

/** Detect if a tab URL is a Google search results page. */
export function isGoogleSearchUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    return (
      (h === 'google.com' || h.startsWith('www.google.') || h.endsWith('.google.com')) &&
      u.pathname === '/search'
    );
  } catch {
    return false;
  }
}
