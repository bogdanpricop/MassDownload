# r/programming

**Subreddit:** https://www.reddit.com/r/programming/

Title:
```
Anti-CAPTCHA via real-tab navigation, MV3 offscreen-document quirks, and other things I learned building a bulk file-downloader Chrome extension
```

Body (this one is more technical, prose-style):

---

I built a Chrome/Edge extension over the past few weeks ([MIT, GitHub](https://github.com/bogdanpricop/MassDownload)) and three implementation details turned out to be more interesting than the product itself.

## 1. Burst-fetching SERPs from a service worker triggers Google CAPTCHA in seconds

First version did the obvious thing: `fetch('https://google.com/search?q=...&start=0')`, parse the response, increment `start` by 100, repeat. Within 2-3 page-loads, Google served a CAPTCHA challenge.

Even with `credentials: 'include'`, randomized delays, and `cache: 'no-store'`, fetch from a service worker behaves differently from a real browser request. Different fingerprint surface (Sec-Fetch-Site headers, no real navigation timing, no client-side rendering of `<noscript>` tags Google looks at).

The fix that worked: open an actual background tab via `chrome.tabs.create({ active: false })`, navigate it page-by-page with `chrome.tabs.update({ url })`, and use `chrome.scripting.executeScript({ func })` to extract anchors after each `loading → complete` cycle. Random 0.8–2s delays between navigations.

Worked first try, ran 50+ pages without a CAPTCHA. The lesson: in the era of headless detection, the cheapest "stealth" measure is to literally not be headless.

Bonus quirk I got bitten by: after `tabs.update({ url })`, the tab stays in `status: 'complete'` (from the *previous* page) for ~50-200ms before transitioning to `loading`. A naive "wait for complete" listener fires immediately on the stale state and you extract the same page twice. Solution: register the listener BEFORE calling update, and require a `loading → complete` transition explicitly.

## 2. MV3 service workers can't `new DOMParser()`

Chromium MV3 service workers don't have `DOMParser`. You need an "offscreen document" — `chrome.offscreen.createDocument({ reasons: ['DOM_PARSER'] })` — and `sendMessage` HTML strings to it for parsing. Annoying boilerplate but it works.

Firefox is the opposite: their MV3 service workers DO expose `DOMParser`, but `chrome.offscreen` doesn't exist. So I ended up with a runtime-detected abstraction:

```ts
export async function callParser(msg: OffscreenMsg): Promise<OffscreenResponse> {
  if (typeof DOMParser !== 'undefined') return parseInProcess(msg);   // Firefox path
  if (typeof chrome.offscreen !== 'undefined') return parseViaOffscreen(msg); // Chromium path
  return { ok: false, error: 'no DOM parser available' };
}
```

Same source builds for both browsers via a `MASSDL_TARGET=firefox` env flag that swaps the manifest at build time.

## 3. Persisting state across service-worker eviction

Chromium aggressively evicts MV3 service workers under memory pressure. A long-running download queue (100+ files) can lose its state mid-batch. The fix:

```ts
// After every 5 settled items
await chrome.storage.local.set({ queueState: { items, completedIds, ... } });
```

On the next side-panel reconnect, background reads the snapshot and emits a `QUEUE_RESUMABLE` message; the UI surfaces a "Resume previous queue?" bar. Cancelled items remain pending; only `done` / `failed` / `skipped` clear from the snapshot. This way "Stop" is also resumable.

## Stack

TypeScript strict (~5500 LoC), Vite + @crxjs/vite-plugin, vanilla TS for UI (no React — bundle stays at ~14KB gzipped). Manifest V3. Chrome / Edge supported, Firefox is experimental.

GitHub: https://github.com/bogdanpricop/MassDownload

Curious about other people's experiences with MV3 quirks. The transition from MV2 has been a mixed bag.

---

## Reply templates

- "Why not Puppeteer / Playwright?" → They're external tools requiring a separate Node process. This is a browser-side extension that uses the user's existing session — no separate auth setup.
- "What about scraping ToS?" → User-driven downloads of files the user already chose. Same legality as right-click → Save As, just automated.
- "Bundle size with vanilla TS?" → 14KB gzipped for sidepanel, 13KB for background. Real React-based MV3 extensions are typically 60-200KB.
