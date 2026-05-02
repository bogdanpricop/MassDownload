# Show HN

Title (under 80 chars, no clickbait, no emoji):

```
Show HN: MassDownload – Bulk-download PDFs from a domain via Google or sitemap.xml
```

Submission URL:
```
https://github.com/bogdanpricop/MassDownload
```

Body (HN doesn't render markdown but uses paragraphs/blank lines):

---

I kept doing the same chore: search Google for `site:example.gov filetype:pdf`, click each result, paginate through 10+ pages, repeat for the next domain. So I built a Chrome/Edge extension that takes the search query, paginates Google in a real background tab (with random human-like delays so it doesn't trigger CAPTCHA from burst-fetching), extracts the result URLs, and bulk-downloads them in parallel.

Three things turned out more interesting than expected:

1. **Anti-CAPTCHA via real-tab navigation.** Burst-fetching SERP pages from a service worker triggers CAPTCHA almost immediately. Opening an actual background tab with the user's session, navigating page-by-page with 0.8–2s random delays, looks indistinguishable from a logged-in user. When CAPTCHA does eventually fire, the extension surfaces the tab so you can solve it in place; the next scan reuses the same tab with the now-clean session.

2. **Sitemap.xml as a fallback.** Google's index is patchy on small institutional sites — government archives, courts, universities. Sitemap mode reads `robots.txt` for `Sitemap:` directives, falls back to `/sitemap.xml` and `/sitemap_index.xml`, recurses through sitemap-index trees, and decompresses gzipped `.xml.gz` inline via `DecompressionStream`. Often finds 5-10x more files than Google has indexed.

3. **Per-host library with `chrome.storage` source-of-truth + regenerated standalone HTML.** Every successful download is recorded with title, snippet description, query, source engine, timestamp, size. After each batch, `Downloads/MassDownload/{host}/library.html` is regenerated from the manifest — a single self-contained file with live search, sort, filter, and `file://` links. Portable to USB / email. Open the in-extension version to add custom titles, tags, and notes (those overlay the immutable scan record).

Other features in v0.3.0: resumable download queues that survive service-worker eviction, recurring scheduled re-scans of saved searches via `chrome.alarms` with desktop notifications on new files, BFS site crawler when sitemap is absent, optional HEAD pre-flight to skip 404s, JSON/CSV export of the library, Firefox build (experimental).

Stack: TypeScript strict, Manifest V3, Vite + @crxjs/vite-plugin, vanilla TS for the side panel and library page. ~5500 LoC. MIT.

What's NOT there yet: Firefox is experimental (sidebar_action vs sidePanel API differences), no resume-after-crash for the SERP scan itself (only for the download queue), no Chrome Web Store listing yet (I want to gather feedback first).

GitHub: https://github.com/bogdanpricop/MassDownload (zip + load-unpacked instructions in the README).

Curious if anyone has hit a similar workflow, and what would make this more useful for OSINT/academic research.

---

## After-post checklist

- [ ] Re-read the post once for typos
- [ ] Have these reply drafts ready in a notepad:
  - "How does it compare to DownThemAll?" → DTA is per-page; this auto-paginates SERP and dedupes against a persistent library. Different scope.
  - "Will Google ban me?" → Uses the user's own browser session at human pace. CAPTCHA is the worst case, not a ban. Sitemap mode bypasses Google entirely.
  - "Why MV3 instead of MV2?" → MV2 is being removed. Side panel API is MV3-only.
  - "Why not just use wget --recursive?" → wget loses your authenticated session and can't paginate Google. This is browser-side on purpose.
- [ ] Set a 2-hour reminder to check replies
