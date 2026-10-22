# Jack 2.0 build log

The working record for Jack 2.0 (#188): what's done, what's next, and every call made along the way. It lives on the `jack-2` branch and is removed or folded into `docs/jack.md` before the release merges.

## Ground rules (from Gray, 10/22)
- Everything in #188 ships as one release. `jack-2` collects reviewed PRs; nothing goes to main piece by piece. Gray merges `jack-2 → main`.
- Bug fixes to Jack today go to main as their own PRs, for Gray to merge.
- Outside services are built against fakes until real accounts and keys exist.
- Claude API test budget: $25 on the existing key (shared with live Jack's $50 Console limit; Gray accepted that).
- Small product calls are made here and listed under Decisions for Gray to review.
- Quality over speed of merging: every PR into `jack-2` gets an independent review before it lands.

## Status

| Area | Status | PR |
|---|---|---|
| Design (`docs/jack-2/design.md`) | In progress | |
| Groundwork: schema, proposed changes, files, scheduler, connectors, who's asking | Not started | |
| Club data: recruiting, race performance, site content, room search | Not started | |
| Memory: knowledge base, seed drafts, officer profiles | Not started | |
| Outside sources: Stripe, Resend, Vercel analytics, Instagram, Twitch, web search | Not started | |
| Documents: Drive, Teams/SharePoint | Not started | |
| Discord: sync, polls, activity, linking, posting, role sync | Not started | |
| Proposed changes in use: news, events, pages, notifications, results, check-ins, imports | Not started | |
| Automation: digest, recurring questions | Not started | |
| Sponsors and meetings | Not started | |
| Decks and rooms | Not started | |
| Eval, security pass, docs, launch post | Not started | |

## Decisions
Calls made during the build, for Gray to review. Newest last.

## Test spend
| Date | What | Cost |
|---|---|---|

## Log
- **10/22:** `jack-2` branched from main at 299e76c. Eval copy (`lsr_eval`) refreshed from prod by Gray.
