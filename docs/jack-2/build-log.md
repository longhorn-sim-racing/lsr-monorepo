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
| Design (`docs/jack-2/design.md`) | v2 done (research + six-lens review folded in) | |
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
- **New nav groups:** Community (Discord, Announcements) and Club (Meetings, Action items, Sponsors) (design §13).

**Design v2 (10/22, after the API research and the six-lens review in `reviews/`):**
- **Storage moves to Supabase Storage:** room files, plus Jack's existing deck renders and exports. Vercel Blob on Hobby allows only 2,000 writes a month, and going over locks it for 30 days. Supabase has no operation cap and supports direct signed uploads (§2.1).
- **Scheduler:**
  - pg_cron calls the site only when a job is due, signed with an HMAC (`SCHEDULER_SIGNING_SECRET`). pg_net's queue is readable by every database role, Jack's included, so a secret can't go in a header.
  - Jack's SQL tool now refuses pg_net, cron, vault and scheduler names.
  - Long jobs (Jack runs, backfills) get their own invocation (§6).
- **Proposals:**
  - claimed first (APPLYING), then applied outside any transaction, with an idempotency key per outside service;
  - a newer proposal supersedes older ones;
  - list kinds allow partial approval;
  - every outcome posts a room note with a link (§4).
- **Discord stores no message content:** only metadata for activity stats. Jack searches live through Discord's API, limited to the channels officers opt in. This avoids holding copies of members' words (§12.1).
- **Tools:**
  - about 22 always loaded; service tools deferred behind tool search;
  - one `search` and `read` across knowledge, documents, rooms, site content, Teams and Discord;
  - `propose_*` tools merged by area;
  - `club_members` gains officer profile fields instead of a new `officers` tool (§7).
- **Automation cap:** recurring questions and Jack-written digest summaries share a **$10/month** cap inside the $50, so they can't crowd out officers (§1).
- **Recruiting privacy in the database:** Jack's SQL role no longer sees draft applications, or reviews/scores/decisions on applications from current officers. Rooms are shared, so an officer must never read their own reviews through Jack (§3.2).
- **Knowledge saves:**
  - only in replies to an officer's own message;
  - duplicate check, version check, secret-pattern check;
  - marked "not reviewed" until an officer reviews them;
  - hard delete available (§9).
- **Release order:** 2.0's migrations go to production **before** the code merges. They're additive, and sign-in reads whole User rows (§17).
- **Connectors ship switched off** and are turned on one at a time after a live smoke test (§1, §17).
- **News proposals are Markdown only,** because news renders as MDX (§4.3).
- **Officer departments** reuse the roster's team ids plus a board flag (§3.3).
- **Standing Discord rules post fixed templates:** public events only, no pings unless an officer names one (§12.1).
- **For Gray to sign off, two key exceptions to "read-only or restricted":**
  - Vercel offers no read-only analytics token. A project-scoped, read-write token is used only by a daily snapshot job, with a short expiry (§12.5).
  - Resend's production key stays send-only, and delivery data arrives by webhook instead.

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
  - API research done: 11 specs in `research/`, each double-checked against official docs.
  - Six-lens design review done (`reviews/`). Design v2 written.
  - **Found on main, fixed separately:** `cost.ts` priced Sonnet 5.5 cache reads at $0.20 per million tokens; Anthropic's pricing page says $0.10. PR #191 (to main, for Gray).
