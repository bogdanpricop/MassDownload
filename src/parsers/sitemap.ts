/**
 * Parse a sitemap XML document. Handles both:
 *  - <urlset>: contains <url><loc>...</loc></url>
 *  - <sitemapindex>: contains <sitemap><loc>...</loc></sitemap> (recursive)
 *
 * Runs inside the offscreen document where DOMParser is available.
 */

export interface SitemapParseResult {
  /** Direct URLs found in <urlset>. */
  urls: string[];
  /** Nested sitemap URLs found in <sitemapindex>. To be fetched recursively. */
  sitemapIndex: string[];
}

export function extractFromSitemapDoc(doc: Document): SitemapParseResult {
  const urls: string[] = [];
  const sitemapIndex: string[] = [];

  // <url><loc>...</loc></url> in urlset
  const urlLocs = doc.querySelectorAll('urlset > url > loc, url > loc');
  for (const loc of Array.from(urlLocs)) {
    const text = loc.textContent?.trim();
    if (text) urls.push(text);
  }

  // <sitemap><loc>...</loc></sitemap> in sitemapindex
  const idxLocs = doc.querySelectorAll('sitemapindex > sitemap > loc, sitemap > loc');
  for (const loc of Array.from(idxLocs)) {
    const text = loc.textContent?.trim();
    if (text && !urls.includes(text)) sitemapIndex.push(text);
  }

  return { urls, sitemapIndex };
}

/** Extract `Sitemap:` directives from a robots.txt body. */
export function extractSitemapsFromRobots(robotsText: string): string[] {
  const out: string[] = [];
  const re = /^\s*Sitemap:\s*(\S+)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(robotsText)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}
