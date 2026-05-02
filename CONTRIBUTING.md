# Contributing to MassDownload

Thanks for your interest! This is a personal project but PRs and issues are welcome.

## Reporting bugs

[Open an issue](https://github.com/bogdanpricop/MassDownload/issues/new/choose) with:

- Browser + version (Chrome 130, Edge 130, etc.)
- OS
- What you did, what you expected, what happened
- Side panel **Log** section content if any errors are shown
- For SERP issues: the exact query, source (Google/Bing/sitemap), and whether CAPTCHA appeared

## Pull requests

1. Fork the repo and clone your fork
2. Create a feature branch: `git checkout -b feat/your-thing`
3. Install deps: `npm install`
4. Make your change
5. Verify it builds cleanly: `npm run build` (must produce **0 TypeScript errors**)
6. Test in `chrome://extensions` → Load unpacked → `dist/`
7. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) prefix:
   - `feat:` new feature
   - `fix:` bug fix
   - `refactor:` code restructure without behavior change
   - `docs:` README/comments only
   - `chore:` build/tooling
8. Open a PR with a clear description of the change

## Style

- TypeScript **strict** mode — no `any` without an inline justification comment
- Prefer pure functions in `parsers/` and `library/`; side effects live in `background.ts` / `sidepanel.ts`
- Match the existing file structure — one concern per file

## Things on the roadmap (good first PRs)

- Firefox port (manifest + side panel API adaptation)
- Resume queue after service worker death
- HEAD pre-check to filter 404s before queuing downloads
- Sync edits from `library.html` back to the extension (tags, notes)
- BFS site crawler when no sitemap exists
- Schedule a saved search to re-run periodically and notify on new files
- Export library as JSON / CSV
- i18n (currently English-only UI)

## License

By contributing you agree your contribution is licensed under [MIT](LICENSE).
