# r/opensource

**Subreddit:** https://www.reddit.com/r/opensource/

Title:
```
MassDownload — MIT-licensed Chrome/Edge extension for bulk-downloading files from any domain (Google, Bing, sitemap.xml). No telemetry, no API key.
```

Body:

---

**Repo:** https://github.com/bogdanpricop/MassDownload

I'm releasing this as a personal weekend project that grew teeth. MIT, no telemetry, no remote config, no sign-in, no ads.

**What it does:**

Type a domain + filetype, get every matching file across all result pages of Google (or Bing, or the site's own sitemap.xml), bulk-downloaded in parallel into a searchable local library.

**Why open-source matters here:**

This is precisely the kind of utility that proprietary tools either gatekeep ($50/mo SerpAPI) or hide telemetry behind ("free Chrome extension that phones home with everything you scan"). I wanted something I could trust on my own machine for research workflows — court decisions, government reports, academic PDFs.

The whole codebase is ~5500 lines of TypeScript strict, MIT, auditable in 30 minutes:

- `src/background.ts` — service-worker orchestrator
- `src/parsers/*` — Google/Bing SERP, sitemap.xml, generic anchor extraction
- `src/library/*` — persistent manifest in chrome.storage + standalone HTML view
- `src/sidepanel/*` — the UI

Things I tried to do right:

- **No `any` without justification** — TypeScript strict, every type comes back from the type checker
- **Permissions justified one-by-one in the README** — you can audit exactly why each one is requested
- **Single-file portable HTML library** — your data is yours, exportable to USB without the extension running
- **CHANGELOG, CONTRIBUTING, issue templates** — the meta-stuff that makes a project actually contributable

**What's missing:**

- Firefox port is experimental — works but `chrome.sidePanel` becomes `sidebar_action`, hasn't been daily-driven
- No automated tests yet (parser tests would be a great first PR)
- Chrome Web Store: planned but not done (wanting feedback first)

If you find a bug or have a feature suggestion, the issue templates are set up. If you want to contribute code, `CONTRIBUTING.md` has a list of good-first-issues.

---

## Reply templates

- "Telemetry?" → Zero. The only HTTP requests it makes are: SERP page fetches (Google/Bing), sitemap fetches, and the file downloads you explicitly pick. You can `grep -r 'fetch\|XMLHttpRequest' src/` to verify.
- "Why MIT not GPL?" → Want maximum permissiveness for forks. If you fork it for your team and don't want to publish back, that's fine.
- "Build instructions?" → `npm install && npm run build`, then load-unpacked from `dist/`. README has the full walkthrough.
