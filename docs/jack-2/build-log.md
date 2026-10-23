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
| Design (`docs/jack-2/design.md`) | Draft written; six-lens review running | |
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
- **Plug-in slots:** every shared registry (tools, prompt sections, schema notes, proposal kinds, jobs, Overview cards) is split into one file per track, so parallel tracks don't edit the same files (design §2.1).
- **Read from our own tables:** Discord, Twitch, Drive/SharePoint, email events and Instagram insights are synced by jobs and webhooks; Jack and the admin pages read the synced copies. Only Stripe and site traffic are fetched live, with a short cache (design §2).
- **One scheduler entry point:** pg_cron calls `/api/cron/tick` every minute; our own `ScheduledJob` table says what's due. The cron secret lives in Supabase Vault. The existing GitHub Actions crons (notifications, recruiting, Instagram) stay as they are (design §6).
- **Proposals:** any officer can apply or discard a proposal in a shared room; the apply runs with that officer's permissions. Pending proposals go stale after 14 days, or as soon as the thing they change has changed (design §4).
- **Files in rooms:** up to 10 files of 25 MB each per message, uploaded straight to the private Blob store (design §5).
- **Knowledge age:** Jack mentions an entry's age when it's over 180 days old (design §7).
- **Tools grouped by source:** about 45 tools instead of 60+. If the cached prompt gets too large or answers get worse, rarely used tools move behind tool search (design §7).
- **New nav groups:** Community (Discord, Announcements) and Club (Meetings, Action items, Sponsors) (design §9).

## Test spend
| Date | What | Cost |
|---|---|---|

## Log
- **10/22:**
  - `jack-2` branched from main at 299e76c. Eval copy (`lsr_eval`) refreshed from prod by Gray.
  - Draft PR #189 opened (`jack-2 → main`).
  - Three codebase surveys saved to `research/codebase-*.md`.
  - API research workflow started (11 services, each double-checked).
  - Design draft written; a six-lens design review is running.
  - **Found on main, fixed separately:** the notifications and Instagram cron routes let requests through when `CRON_SECRET` is unset. PR #190 (to main, for Gray to merge) makes every cron route fail closed. `jack-2` picks it up after it merges.
  - Delivered on the side: the Jack deep-dive deck (`Jack - How It Works.html`/`.pdf` on Gray's Desktop).
