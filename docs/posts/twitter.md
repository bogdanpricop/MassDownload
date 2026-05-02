# Twitter / X / Mastodon / Bluesky

Same content works on all four. Mastodon allows ~500 chars/post so the thread breaks naturally there.

## Thread (5 posts)

**1/5** — Hook + screenshot
```
I kept doing the same chore: search Google for `site:example.gov filetype:pdf`, click each result, paginate through 10+ pages, repeat for the next domain.

So I built a Chrome/Edge extension that does it in one click.

🔗 github.com/bogdanpricop/MassDownload (MIT, no telemetry)
```
Attach: `docs/screenshots/sidepanel-search.png`

**2/5** — How it works
```
2/ The "obvious" way fails: fetch SERP pages from a service worker → Google CAPTCHA in 3 requests.

What works: open a real background tab, navigate page-by-page with random 0.8-2s delays. Indistinguishable from a logged-in human. Ran 50+ pages without a CAPTCHA in tests.
```

**3/5** — Sitemap fallback
```
3/ Google's index is patchy on small institutional sites. So there's a sitemap.xml mode too: reads robots.txt for Sitemap: directives, recurses through sitemap-index trees, decompresses gzipped .xml.gz inline.

Often finds 5-10x more files than Google has indexed.
```
Attach: `docs/screenshots/sidepanel-results.png`

**4/5** — Library
```
4/ Every download is recorded in chrome.storage with title, snippet, query, timestamp, size.

A standalone library.html is auto-regenerated per host: live search, sort, filter, file:// links to the local downloads. Portable to USB or email.

Open it in-extension to add tags + notes.
```
Attach: `docs/screenshots/library-html.png`

**5/5** — Stack + close
```
5/ Stack: TypeScript strict, MV3, Vite. ~5500 LoC. Vanilla TS for the UI — bundle stays ~14KB gzipped.

Chrome + Edge supported, Firefox port is experimental.

🔗 github.com/bogdanpricop/MassDownload
📦 Pre-built zip in Releases — no Node.js needed to install.
```

## Single-tweet variant

If you don't want a thread:

```
Built a Chrome/Edge extension that bulk-downloads files from any domain.

Type "site:example.gov filetype:pdf", get every result across all Google pages — into a searchable local library with tags + notes.

MIT, no telemetry, MV3.

🔗 github.com/bogdanpricop/MassDownload
```
Attach: `docs/screenshots/social-preview.png`

## Hashtags / mentions

- `#opensource` `#ChromeExtension` `#TypeScript` `#OSINT`
- Tag `@github` if you want repo discovery boost (small effect, doesn't hurt)
- Don't tag platforms you scrape (`@google` `@bing`) — invites moderation drama you don't want
