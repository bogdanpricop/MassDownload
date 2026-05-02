# Launch posts

Drafts to copy-paste when you decide to post about MassDownload publicly. Each one is tuned to the platform's audience and conventions. Do not post all at once — space them out by 2-3 days each, ideally Show HN first (it's the highest-friction venue and feedback there improves the others).

## Order I'd recommend

1. **Show HN** — highest signal, best feedback, peak ~9 AM PT Tuesday-Thursday
2. **r/chrome_extensions** — your direct user audience
3. **r/opensource** + **r/programming** — broader visibility
4. **Twitter / X** — share once the others have traction

## Files

| File | Audience | Key angle |
|---|---|---|
| [`show-hn.md`](show-hn.md) | HN technical readers | "I built X to scratch Y itch" — show the technical problem |
| [`reddit-chrome-extensions.md`](reddit-chrome-extensions.md) | Chrome extension users | Concrete use case + comparison to existing tools |
| [`reddit-opensource.md`](reddit-opensource.md) | r/opensource community | MIT license, no telemetry, MV3 reference |
| [`reddit-programming.md`](reddit-programming.md) | r/programming | Technical details — anti-CAPTCHA, sitemap recursion, MV3 quirks |
| [`twitter.md`](twitter.md) | Twitter / X / Mastodon | Single-thread tease + screenshots |

## Tips

- **First reply matters most.** Have answers ready for: "How does this compare to DownThemAll?", "Will Google ban me?", "Why MV3 over MV2?"
- **Don't be defensive about scraping.** Your tool uses the user's own session, doesn't scrape at scale, and respects robots.txt indirectly via sitemap discovery.
- **Pin a comment with the GitHub link** even when the post body has it — Reddit hides post URLs sometimes.
- **Reply to every comment in the first 4 hours.** That's where engagement metrics get computed.
- **If something blows up:** the v0.2.0 zip is already at `https://github.com/bogdanpricop/MassDownload/releases/latest`, no further action needed.
