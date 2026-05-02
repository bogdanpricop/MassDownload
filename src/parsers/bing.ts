import type { LinkInfo } from '../types';

const BING_INTERNAL_HOSTS = [
  'bing.com',
  'microsoft.com',
  'msn.com',
  'live.com',
  'go.microsoft.com',
];

function isBingInternal(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return BING_INTERNAL_HOSTS.some((needle) => h === needle || h.endsWith('.' + needle));
}

/**
 * Bing wraps some result links in `https://www.bing.com/ck/a?...&u=BASE64URL&...`
 * Decode `u` (base64url, sometimes with `a1` prefix that must be stripped).
 */
function unwrapBingRedirect(rawHref: string): string | null {
  try {
    const u = new URL(rawHref, 'https://www.bing.com');
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (isBingInternal(u)) {
      // Try to extract `u=` redirect param
      if (u.pathname.startsWith('/ck/')) {
        const encoded = u.searchParams.get('u');
        if (encoded) {
          // Bing sometimes prefixes with "a1" — strip if present
          const stripped = encoded.replace(/^a\d+/, '');
          try {
            const padded = stripped + '='.repeat((4 - (stripped.length % 4)) % 4);
            const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
            if (/^https?:\/\//i.test(decoded)) return decoded;
          } catch {
            /* fall through */
          }
        }
      }
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

export interface BingParseResult {
  items: LinkInfo[];
  isCaptcha: boolean;
}

export function extractLinksFromBingDoc(doc: Document): BingParseResult {
  // CAPTCHA detection from HTML alone is unreliable for Bing (the word "captcha"
  // appears in benign places like footer text or accessibility labels).
  // Background's fetch path does the authoritative check via the response URL.
  // Here we only flag if a known challenge selector is present.
  const isCaptcha =
    !!doc.querySelector('form[action*="/challenge/"]') ||
    !!doc.querySelector('div#challenge-form') ||
    !!doc.querySelector('iframe[src*="captcha-delivery.com"]');

  function extractDescription(algo: Element): string | undefined {
    // Bing's organic results put snippets in `.b_caption p` or `.b_lineclamp*`.
    const selectors = ['.b_caption p', '.b_lineclamp2', '.b_lineclamp3', '.b_paractl'];
    for (const sel of selectors) {
      const el = algo.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && text.length >= 20) return text.slice(0, 600);
    }
    return undefined;
  }

  const items: LinkInfo[] = [];
  // Each organic result is in <li class="b_algo">. Title is the first <h2><a>.
  const algos = doc.querySelectorAll('li.b_algo, .b_algo');
  for (const algo of Array.from(algos)) {
    const titleAnchor = algo.querySelector('h2 a, .b_title a') as HTMLAnchorElement | null;
    const href = titleAnchor?.getAttribute('href');
    if (!href) continue;
    const real = unwrapBingRedirect(href);
    if (!real) continue;
    const title = titleAnchor?.textContent?.trim() || undefined;
    const description = extractDescription(algo);
    items.push({ url: real, title, description });
  }

  // Fallback: if no .b_algo found (Bing sometimes ships variant layouts), grab all anchors
  if (items.length === 0) {
    const anchors = doc.querySelectorAll('a[href]');
    for (const a of Array.from(anchors)) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const real = unwrapBingRedirect(href);
      if (!real) continue;
      const title = a.textContent?.trim() || undefined;
      items.push({ url: real, title });
    }
  }

  return { items, isCaptcha };
}

/** Build the Bing pagination URL for a given offset. */
export function buildBingPageUrl(originalUrl: string, first: number, count: number): string {
  const u = new URL(originalUrl);
  u.searchParams.set('first', String(first));
  u.searchParams.set('count', String(count));
  return u.toString();
}
