# MassDownload — Chrome Extension

Mass-download files (PDFs, docs, anything) from a website by querying **Google**, **Bing**, or the site's own **sitemap.xml** — across all result pages.

## Use case

You're collecting documents from a domain — say `website-domain.ro` for PDFs of court decisions. Without MassDownload you'd have to:

1. Open Google
2. Type `site:website-domain.ro filetype:pdf`
3. Click each PDF
4. Paginate through 10+ Google pages
5. Repeat for the next site

With MassDownload:

1. Click the toolbar icon
2. In the side panel: site = `website-domain.ro`, filetype = `pdf`
3. Click **Search** → all PDFs across all pages are listed
4. Click **Download selected** → all are downloaded in parallel

Saved searches let you re-run a query in 1 click. Sitemap mode finds documents Google never indexed.

## Three scan sources

| Source | When to use | How |
|---|---|---|
| **Google** (default) | Need only what Google indexes; site has no public sitemap | Builds `site:X filetype:Y` query, paginates `start=0,100,…&num=100`. **Auto-falls back to Bing on CAPTCHA.** |
| **Bing only** | Google rate-limited; alternative result set | Uses `bing.com/search?q=site:X filetype:Y`, paginates `first=1,51,101,…&count=50`. Bing rarely CAPTCHAs. |
| **Sitemap.xml** | Site has a sitemap; you want **everything**, not just indexed pages | Reads `robots.txt` for `Sitemap:` directives, falls back to `/sitemap.xml`, `/sitemap_index.xml`. Recursively follows sitemap-index trees (max depth 3, max 50 sitemap files). Supports gzipped `.xml.gz`. |

The side panel also has a **Scan tab** button: parses the active tab as Google SERP if the URL matches, otherwise extracts every `a[href]` from the page (generic mode).

## Smart filename

When Google/Bing supply a result title (`<h3>` text), it's used as the filename instead of the URL pathname. So:

- URL `https://example.com/cgi-bin/dl.php?id=7821` + title `"Decizia 312/2024"` → file `Decizia 312_2024.pdf`
- URL `https://example.com/papers/foo.pdf` (no title from snippet) → file `foo.pdf`

## Saved searches

A "Save" button stores the current query (site + filetypes + keywords + exclude + source) in `chrome.storage.local`. The side panel lists them, click to re-run.

## How the build works

| Component | Role |
|---|---|
| Side panel (vanilla TS + CSS) | Form, saved searches, results, progress |
| Service worker (`background.ts`) | Orchestrates fetch + parse + download queue |
| Offscreen document | DOMParser host for Google/Bing HTML and sitemap XML (not available in MV3 service workers) |
| `chrome.scripting` | Generic-page link extraction via inline `func` |
| `chrome.downloads` | File downloads with `conflictAction: 'uniquify'` |

## Install

### Option A — Pre-built zip (no Node.js required) ⭐ recommended for users

1. Go to the [latest release](https://github.com/bogdanpricop/MassDownload/releases/latest).
2. Download `MassDownload-v0.1.0.zip` from the release assets.
3. Extract the archive somewhere stable (e.g. `C:\Users\you\Apps\MassDownload\`). **Don't pick a temp folder** — the browser will keep loading the extension from this path, so deleting the folder later breaks it.
4. Open the extension manager:
   - Chrome / Brave / Vivaldi: `chrome://extensions`
   - Microsoft Edge: `edge://extensions`
5. Toggle **Developer mode** (top-right in Chrome, left sidebar in Edge).
6. Click **Load unpacked** and select the extracted folder (the one that contains `manifest.json`).
7. Pin the MassDownload icon to the toolbar — click it on any tab to open the side panel.

To update later: download the new zip, replace the folder contents, then click the **🔄 Reload** button on the extension's card in `chrome://extensions`.

### Option B — Build from source (developers)

Requires Node.js 18+ and npm.

```bash
git clone https://github.com/bogdanpricop/MassDownload.git
cd MassDownload
npm install
npm run build      # outputs dist/
```

Then in your browser: `chrome://extensions` (or `edge://extensions`) → **Developer mode** → **Load unpacked** → select the `dist/` folder.

### Dev with HMR

```bash
npm run dev
```

Reload the extension once, then the side panel hot-reloads.

## Saving files in one folder, no per-file prompts

The extension calls `chrome.downloads.download({ saveAs: false })` so files save automatically without a "Save As" dialog. Out of the box, files land in `Downloads/MassDownload/{host}/` — a separate subfolder per site, set via the **Subfolder** field. Use `{host}` for per-site organization, or set a fixed path like `Documente/Curte`, or leave empty to dump into `Downloads/`.

**One-time folder picker.** The **Pick…** button next to the Subfolder field opens the system Save-As dialog once. Whatever folder you choose (must be inside `Downloads/`) is saved as the subfolder pattern, and every subsequent file in any queue goes there silently.

**If the browser still prompts for each file** (you see *"What do you want to do with X.pdf?"* with Open / Save as / Save buttons), the browser has a global "ask before downloading" setting turned on. No extension can override that — disable it once:

| Browser | Path | Setting to turn OFF |
|---|---|---|
| **Microsoft Edge** | `edge://settings/downloads` | *Ask me what to do with each download* |
| **Google Chrome** | `chrome://settings/downloads` | *Ask where to save each file before downloading* |
| **Brave / Vivaldi** | `brave://settings/downloads` / `vivaldi://settings/downloads` | same as Chrome |

The side panel has an **Open browser download settings** link in the Settings section that takes you straight there (auto-detects Edge vs Chrome from the user agent).

## Settings

| Field | Default | Range / notes |
|---|---|---|
| Filetype(s) | `pdf` | Comma-separated. Used as both query filter (`filetype:pdf`) and post-scan extension filter |
| Source | Google | google / sitemap / bing |
| Keywords | empty | Free text appended to query |
| Exclude | empty | Comma-separated, each becomes `-term` in query |
| Parallel downloads | 5 | 1 – 20 |
| Max pages | 20 | 1 – 50 (also caps sitemap files visited) |
| Subfolder | empty | Optional, supports `{host}` (e.g. `MassDownload/{host}` → `Downloads/MassDownload/bej-cojocaru.ro/file.pdf`) |
| Saved searches | (managed via UI) | up to 30 stored |

All persist via `chrome.storage.local`.

## Project layout

```
src/
├── background.ts             # service worker — scan dispatcher + download queue
├── offscreen.html / .ts      # DOMParser host
├── sidepanel/
│   ├── sidepanel.html        # Quick Search form, saved list, results, progress
│   ├── sidepanel.ts          # UI state + port to background
│   └── sidepanel.css
├── parsers/
│   ├── google.ts             # SERP parsing + /url?q= unwrap, smart titles
│   ├── bing.ts               # SERP parsing + /ck/a?u= base64 redirect unwrap
│   ├── sitemap.ts            # urlset / sitemapindex extraction + robots.txt
│   ├── queryBuilder.ts       # site/filetype/keywords → search URL
│   └── filters.ts            # extension match, dedup, sanitize, smart filename
├── downloader.ts             # parallel download queue + cancel + retry
├── messages.ts               # typed messages (sidepanel ↔ background ↔ offscreen)
├── storage.ts                # settings + saved searches
└── types.ts                  # LinkInfo, SearchQuery, SavedSearch, Settings
```

## Scan flow internals

### Google query
1. Build `https://www.google.com/search?q=site:X+filetype:Y+keywords+-exclude&num=100&filter=0`
2. Loop `start=0,100,200,…` up to `maxPages`
3. Each response → offscreen → DOMParser → `extractLinksFromGoogleDoc(doc)`
4. Stop when: no new unique URLs, fewer-than-half results returned, or HTTP 429/503/CAPTCHA
5. On CAPTCHA: emit partial `SCAN_DONE`, then retry on Bing (auto-fallback) and merge

### Sitemap
1. `GET site/robots.txt` → extract `Sitemap:` directives
2. Add fallbacks: `/sitemap.xml`, `/sitemap_index.xml`
3. BFS over discovered sitemaps (max depth 3, max 50 visited)
4. For each: fetch, decompress if gzip, offscreen → `DOMParser` → `extractFromSitemapDoc(doc)`
5. `<urlset>` → harvest `<loc>` URLs; `<sitemapindex>` → enqueue children
6. Filter post-hoc by extension

### Bing
- Same shape as Google: `first=1,51,101…&count=50`
- Bing redirect unwrapping handles `bing.com/ck/a?u=BASE64URL` (with optional `a1` prefix)

## Limitations / known gotchas

- **CAPTCHA**: Google still wins eventually if you scan many sites in a row. Auto-fallback to Bing reduces but doesn't eliminate the problem. Sitemap mode bypasses search engines entirely.
- **Sitemaps may lie**: some sites list URLs that 404; failed downloads are reported in the log but the queue continues.
- **Files behind login**: download follows your existing browser cookies — works only if Chrome is already logged in to that site.
- **JavaScript-only sites**: sitemap mode finds URLs the server publishes; if the site renders link lists in JS only, generic-tab mode can still work but you must manually scroll/load before scanning.
- **Resume after crash**: not implemented. Service worker death loses queue progress (in-flight downloads continue — Chrome owns them).

## Permissions explained

| Permission | Why |
|---|---|
| `sidePanel` | Side panel UI |
| `downloads` | Save files |
| `activeTab` + `scripting` | Generic-mode link extraction from current tab |
| `storage` | Persist settings and saved searches |
| `offscreen` | DOMParser for Google/Bing HTML and sitemap XML |
| `tabs` | Read active tab URL |
| `<all_urls>` (host) | Fetch any Google locale, any Bing endpoint, any site's robots.txt/sitemap |

No telemetry. No remote config. Nothing leaves your browser except the requests required to fetch the search pages and the files you choose to download.
