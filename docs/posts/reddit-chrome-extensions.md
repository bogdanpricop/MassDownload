# r/chrome_extensions

**Subreddit:** https://www.reddit.com/r/chrome_extensions/

Title:
```
[Open source] MassDownload — bulk-download PDFs from any domain via Google, Bing, or sitemap.xml, with a searchable per-host library
```

Flair: `Tool` or `Open Source` if available

Body:

---

Hi all — I built this for myself first (collecting court decisions / public reports) and figured others might find it useful. Free, MIT-licensed, no telemetry, works in Chrome and Edge (Firefox port is experimental).

**The chore it solves:**

Type `site:example.gov filetype:pdf` in Google, hit Search. Now click 10+ pages of results, save each PDF manually. Repeat for the next site. MassDownload turns this into one button click.

**How it works:**

1. Open the side panel from the toolbar icon
2. Type the site + filetype (or pick from saved searches)
3. The extension paginates Google for you — but in a real background tab, not via fetch — with random delays so you don't trip CAPTCHA from burst-fetching
4. Picks the result URLs, deduplicates against your existing library, and bulk-downloads in parallel
5. Auto-generates a per-host `library.html` with live search / filter / sort, accessible from the **Library** button or as a portable file in `Downloads/MassDownload/{host}/`

**What sets it apart from existing tools:**

- **DownThemAll** is per-page only — you still have to paginate Google manually
- **wget --recursive** can mirror a site, but loses your browser session and doesn't speak Google
- **SerpAPI** is industrial-grade but $50/mo
- This is browser-side, free, uses your actual session, and dedupes downloads across runs

**v0.3.0 features:**

- 4 source modes: Google (default), Bing (fallback when Google CAPTCHAs), sitemap.xml (recursive, gzip-aware), BFS site crawler
- Saved searches + scheduled recurring re-scans (gets new files automatically, fires desktop notifications)
- Resumable downloads — if Chrome evicts the service worker mid-batch, you get a "Resume?" bar on the side panel
- Optional HEAD pre-flight to skip 404s before downloading (useful for stale sitemaps)
- Editable in-extension library: add custom titles, tags, notes; export JSON/CSV
- Pre-flight folder picker so files save without per-file "Save as?" prompts (one-time setup)

**Install:** download the zip from [Releases](https://github.com/bogdanpricop/MassDownload/releases/latest), extract, `chrome://extensions` → Developer mode → Load unpacked. Detailed steps in the README.

**Repo + screenshots:** https://github.com/bogdanpricop/MassDownload

Happy to take feedback or feature requests. PRs welcome — there's a `CONTRIBUTING.md` with a roadmap of good-first-issues.

---

## Reply templates

- "Why not Web Store?" → Want to gather feedback first; will list for the $5 fee once I'm confident in stability across more browsers.
- "Does it scrape sites?" → It downloads files YOU pick from a results list. The "scraping" is just paginating Google — same thing you'd do manually, just automated. Uses your existing session.
- "Edge support?" → Yes, tested on Edge from day one (it's my daily driver).
