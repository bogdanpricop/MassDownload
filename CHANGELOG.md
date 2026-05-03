# Changelog

All notable changes to MassDownload will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] — 2026-05-03

Small UX patch focused on the **Site** input in the Quick Search form.
No new features or breaking changes; safe drop-in for any v0.3.x install.

### Changed
- **Site input auto-cleans pasted URLs.** If you paste
  `https://www.example.com/foo/bar?x=1#h` (or anything similar), the field
  rewrites itself to `example.com` immediately. Stripping happens on
  paste, on blur, and again at query-build time as defense-in-depth, so
  even a fast Search click before blur fires produces a clean query.
- **Site placeholder generalized** from a specific domain to `example.com`.
- **Filetype(s) label** now reads `Filetype(s) — comma-separated`, putting
  the format hint next to the label instead of only in the placeholder.

### Why
Half the time when scoping a scan to a domain, you copy the URL from
the address bar — which includes `https://`, `www.`, and a path. Forcing
the user to manually delete those parts was friction; doing it
automatically is the right default.

## [0.3.0] — 2026-05-02

Editable library + Firefox port (experimental). Three additions: a real
in-extension library page where files can be tagged / annotated / removed,
a runtime-detected DOM-parser abstraction so the same source builds for
both Chromium and Firefox, and copy-ready promotional drafts under
`docs/posts/`.

### Added
- **Editable in-extension library page** at `chrome-extension://.../src/library/page.html`.
  Adds:
  - `customTitle` overlay on top of the immutable scan title
  - Tags (lowercase, deduplicated, comma-separated entry)
  - Notes (free-text, multi-line)
  - Per-card actions: Show in folder (via `chrome.downloads.show`),
    Copy source URL, Remove from library
  - Tag filter pills above the results (toggle multiple to AND-filter)
  - Host filter dropdown (defaults to the host that was active when
    the side panel's Library button was clicked)
  - Per-host portable HTML regeneration button (the `Downloads/MassDownload/{host}/library.html`
    is rebuilt to reflect the latest tags/notes/customTitles)
  - Same JSON/CSV export, but now including the new editable fields
  - Search now matches against `customTitle`, `tags`, and `notes` too
- **Firefox build (experimental)** — new `npm run build:firefox` outputs
  `dist-firefox/` with a Firefox-flavored manifest:
  - `sidebar_action` instead of `side_panel`
  - `background.scripts` instead of `background.service_worker`
  - `browser_specific_settings.gecko` block with extension id
  - drops `sidePanel` + `offscreen` permissions (don't exist on Firefox)
- **`parseHost.ts`** — runtime-detected DOM parsing abstraction:
  - On Chromium: routes via offscreen document (DOMParser unavailable in SW)
  - On Firefox: parses inline using the SW's native DOMParser
  - Single `callParser(msg)` API consumed by background.ts; no per-call
    branching in business logic
- **`docs/posts/`** — copy-ready launch posts for Show HN,
  r/chrome_extensions, r/opensource, r/programming, and Twitter/X/Mastodon,
  with reply templates for the predictable questions

### Changed
- `LibraryEntry` shape gained optional `customTitle`, `tags`, `notes`. Old
  entries continue to work — these fields default to undefined.
- The on-disk portable `library.html` now renders custom titles + tags +
  notes (read-only). Editing happens only in the in-extension page.
- Sidepanel **Library** button now opens the in-extension editable page
  in a new tab instead of revealing the on-disk HTML in Explorer. The
  on-disk HTML is still regenerated automatically and can be opened
  directly from `Downloads/MassDownload/{host}/library.html`.
- Manifest version bumped to 0.3.0; the same source compiles for both
  browser targets via a `MASSDL_TARGET=firefox` env flag at build time.

### Technical notes
- Library API messages (`LIBRARY_LIST` / `LIBRARY_UPDATE_ENTRY` /
  `LIBRARY_REMOVE_ENTRY` / `LIBRARY_REGENERATE_DISK_HTML`) use one-shot
  `chrome.runtime.sendMessage` instead of the long-lived port that
  sidepanel uses. Port-based comms are appropriate for streaming progress;
  one-shot is cleaner for CRUD on a single record.
- Tag normalization (lowercase, trim, dedup, drop empties) is enforced in
  `library/manifest.ts:updateEntry` so the storage shape stays clean
  regardless of UI input.
- Firefox build is marked **experimental** because while it compiles and
  loads, it hasn't been daily-driven yet. The README has a note flagging
  the gaps (sidebar_action UX differences, untested SW eviction behavior).

## [0.2.0] — 2026-05-02

Major feature release. Five additions that make the extension a real
research tool, not just a bulk downloader.

### Added
- **JSON / CSV export** from the library HTML — two new buttons in the
  controls row download the current filtered list. CSV uses RFC 4180
  quoting + UTF-8 BOM (Excel-friendly); JSON is pretty-printed.
- **Pre-flight HEAD check** (opt-in setting, default off) — sends a HEAD
  request before each download with a 3s timeout. URLs that return 404/410
  are marked `skipped` and don't consume a download slot. Especially
  useful for sitemap mode where stale URLs are common.
- **Resumable download queues** — the queue is persisted to
  `chrome.storage.local` after every 5 settled items. If the service
  worker is evicted mid-batch, opening the side panel surfaces a
  *"Resume previous queue?"* bar showing pending count and start age.
  Cancelled items remain pending; completed items are filtered out.
- **BFS site crawler** as a new source mode — pulls all `a[href]` from a
  site's homepage, follows intra-domain HTML links up to depth 2 and
  100 pages, harvests files matching the requested extensions.
  Useful for sites with no sitemap and patchy Google indexing.
- **Recurring scheduled re-scans** of saved searches — click the ⌚ icon
  next to a saved search to set an interval in days. The extension wakes
  up via `chrome.alarms`, re-runs the scan headlessly, downloads only
  files that aren't already in the library, and (optionally) shows a
  desktop notification for the new files. Survives SW eviction; the
  alarm is owned by the browser, not the extension's runtime.

### Changed
- `chrome.storage` `Settings` shape gained `preflightCheck: boolean`
  (default false). Existing installs migrate transparently — missing
  fields fall back to defaults via `loadSettings()`.
- `SavedSearch` shape gained an optional `schedule` block. Old saved
  searches without it continue to work unchanged.
- Manifest `permissions` extended with `alarms` (recurrent re-scans)
  and `notifications` (new-file alerts on scheduled runs).

### Technical notes
- Library HTML is regenerated after every successful batch — including
  scheduled batches — so `Downloads/MassDownload/{host}/library.html`
  stays in sync without manual intervention.
- Scheduler reconciles `chrome.alarms` with saved searches on
  `onInstalled` + `onStartup` + storage-change events. Stale alarms
  for deleted searches are pruned automatically.
- `cancelled` items are deliberately preserved in the persisted queue so
  Resume can pick them up. Only `done` / `failed` / `skipped` clear from
  the snapshot.
- BFS crawler skips obvious binary asset extensions (.png, .css, etc.)
  during link traversal to avoid wasted fetches.

## [0.1.1] — 2026-05-02

Documentation and discoverability polish. **No functional changes** — the
extension behavior is identical to 0.1.0; the zip is rebuilt only so the
manifest version stays in sync.

### Added
- MIT `LICENSE`
- `CHANGELOG.md` (Keep a Changelog format)
- `CONTRIBUTING.md` with style guide, conventional-commit prefixes, and a
  good-first-issue roadmap
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config.yml}` —
  blank issues disabled, Discussions linked
- UI screenshots in `docs/screenshots/` (Quick Search, results, library,
  social preview) embedded in README
- Repo metadata: 16 GitHub topics, sharper description, Discussions enabled

### Changed
- README rewritten for discoverability: hero block with shields.io badges,
  TOC, comparison table vs DownThemAll / Simple Mass Downloader / wget /
  SerpAPI, audience-specific use-case sections, FAQ
- Install instructions split into Option A (pre-built zip, recommended) and
  Option B (build from source)

## [0.1.0] — 2026-05-02

Initial public release.

### Added
- **Quick Search dialog** — site + filetype + keywords + exclude form, builds the search URL internally so no Google tab needs to be open
- **Stealth Google paging** — opens a real background tab and navigates page-by-page with random 0.8–2s delays, much less likely to trigger CAPTCHA than burst-fetching
- **Auto-fallback to Bing** — when Google CAPTCHAs, results found so far are merged with Bing's results
- **Sitemap.xml mode** — discovers sitemaps from `robots.txt` and common defaults, recursively follows sitemap-index trees, supports gzipped `.xml.gz`
- **Per-host library** — every successful download is recorded in `chrome.storage.local` with title, description, query, source, timestamp, size; a self-contained `library.html` with live search, sort, filter, and `file://` links is regenerated per host after each batch
- **Smart filename derivation** from search-result titles instead of opaque URL paths
- **Scan-time dedup** — files already in the library appear with a badge and unchecked checkbox
- **Save-As folder picker** — one-click subfolder configuration via the system dialog
- **Auto open browser download settings** — link in side panel surfaces the *"Ask each download"* setting on Edge/Chrome/Brave
- **Saved searches** — store up to 30 frequent queries for one-click re-run
- **Parallel download queue** — configurable concurrency (default 5), one-shot retry on `NETWORK_*` errors, cancel-all on Stop
- **CAPTCHA tab surfacing** — when Google challenges, the scan tab is activated and its window is focused so the user can solve in place; the next scan reuses the same tab with a clean session

### Technical
- TypeScript strict, MV3, Vite + `@crxjs/vite-plugin`
- Service worker orchestrates fetch/parse/download
- Offscreen document for `DOMParser` (not available in MV3 service workers)
- Long-lived port between sidepanel and background for streaming progress

[Unreleased]: https://github.com/bogdanpricop/MassDownload/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/bogdanpricop/MassDownload/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/bogdanpricop/MassDownload/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bogdanpricop/MassDownload/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/bogdanpricop/MassDownload/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bogdanpricop/MassDownload/releases/tag/v0.1.0
