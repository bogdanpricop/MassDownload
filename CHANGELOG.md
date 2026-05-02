# Changelog

All notable changes to MassDownload will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/bogdanpricop/MassDownload/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/bogdanpricop/MassDownload/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bogdanpricop/MassDownload/releases/tag/v0.1.0
