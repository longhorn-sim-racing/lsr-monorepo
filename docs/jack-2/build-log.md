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
| G1: schema, migrations, RLS, scheduler SQL | Merged | #192 |
| G1: interfaces, plug-in slots, display kinds | Merged | #193 |
| G1: 2.0 prompt, run_sql hardening, CI, dependencies | Merged | #194 |
| G1 follow-ups (search index revoke, typed prompt slots) | Merged | #196 |
| R: services for event, results and news changes | Merged | #197 |
| G2: connector framework, HTTP fakes, Connections page | Merged | #199 |
| G3: scheduler (signed tick, dispatcher, hand-offs, Scheduled jobs page) | Merged | #205 |
| G4: proposals (cards, Proposals page, `page.update`) | Merged | #201 |
| G5: file storage and room uploads | Merged | #203 |
| G8: model loop 2.0 (web search and fetch, citations, tool search, documents, cost) | Merged | #198 |
| E: eval harness 2.0 | Merged | #200 |
| T1: club data (search and read, recruiting pipeline, race performance, room search) | Merged | #204 |
| T2: memory (knowledge base, knowledge tool, officer profiles) | Merged | #202 |
| I: wave-1 integration follow-ups | Merged | #206 |
| T9a: rooms (archive, pin, mention mode, ratings, Usage page) | Merged | #207 |
| G6: Jack reads room files, and who's asking | Merged | #208 |
| T10: sponsors, meetings and action items | Merged | #209 |
| T4: Stripe, Resend delivery and site traffic | Merged | #210 |
| T3: event, news, notification, results, check-in and import proposals | Merged | #211 |
| T6: documents (Drive, SharePoint, Teams; switchable) | Merged | #212 |
| T5: Twitch and Instagram insights | Merged | #213 |
| T7: Discord reading (sync, search, polls, activity, linking) | Merged | #214 |
| Vercel function limit (narrow Chromium tracing, one time limit) | Merged | #215 |
| Fixes from the live checks (web sources, PDFs with web fetch, eval checks) | Merged | #218 |
| I2: wave-2a integration follow-ups | Merged | #217 |
| T8: Discord posting (posts, polls, standing rules, event mirror, role sync, Announcements) | Merged | #221 |
| T11: automation (recurring questions, weekly digest, Needs attention) | Merged | #220 |
| T9b: Instagram publish and gallery add | Merged | #219 |
| Security fixes: Jack's reply surface; privacy (Discord purges, account deletion); change proposals | Merged | #222–#224 |
| Docs folded in, and the release runbook | Merged | #226, #225 |
| Security fixes, wave 2b: the digest and recurring questions; Instagram publishing; Discord posting | Merged | #227–#229 |
| Eval fixes (harness checks, prompt and tool fixes from the paid run) | Merged | #230 |
| Main's fixes merged into `jack-2` (#190, #191, #195, #216) | Merged | |
| Release decisions (runbook section 5) | Decided 10/25 | |
| Launch post | Drafted (with Gray) | |

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
- **Search index is one side table (`JackSearchDoc`)** kept current by triggers, instead of tsvector columns: Prisma can't read tsvector, so a column would break Jack's `SELECT *` queries, including today's Jack once migrations reach production (G1-data review).
- **The audit log hides recruiting entries about officers' own applications** from Jack (RLS policy plus the `audit_log` tool). Those entries carry review scores and decisions (G1-data review).
- **Knowledge seed content never goes in the repo** (it's public). Drafts live in `~/.lsr/jack-knowledge-seed/`, and the load script reads them from there.
- **Jack's SQL role has no grant on the search index** (`JackSearchDoc`). `run_sql` reports it off-limits, like `SystemSetting`.
- **`run_sql` refuses `ts_rewrite`** (it runs a query from a string). Found in the G1-prompt review; also live on main, so it's fixed there in #195.
- **The `propose_*` tools are generic:** each builds its input from the kinds registered for it (`kindsForTool`), so tracks add kinds without editing each other's tool files.
- **Wave 1 calls (from the PRs):**
  - **Connections:** switching a connection on is refused until its code, env vars and settings are there; switching on without a passing smoke test asks first; off always works. One `JACK_FAKES` switch points every client at the local fakes (G2).
  - **Scheduler:** a job's lock lasts claim + 360 s; "Run now" needs the job switched on; officers see Scheduled jobs read-only, and only admins switch, run or reschedule (audited) (G3).
  - **Proposals:** one new nullable column, `JackProposal.view`, keeps the card as it was proposed. The sweep job (every 10 min) marks stuck applies failed and expired proposals stale (G4).
  - **Files:**
    - HEIC photos are refused with "export it as JPEG" (the installed sharp can't decode HEVC).
    - Supabase Storage is used whenever the service-role key and a hosted Supabase URL are set; locally the files store stays the default.
    - Registration is a route, not a server action, so reading a big PDF doesn't hold up the room (G5).
  - **Model loop:** web tools stay off until `JACK_WEB_TOOLS=on` and the Console allows them. Recurring-question notes are flagged `JackMessage.scheduled` (one new column) so their replies get no web tools (G8).
  - **News:** a taken slug now says "Slug already exists" (the old check never matched, so it said "Failed to create post") (R).
  - **Release order (T2):** run the officer badge sync with `--apply` before loading the knowledge seed, so department owners resolve.
  - **Tests:** Vitest's per-test timeout is 20 s. A few tests import whole module graphs and took over 5 s while the full suite ran in parallel.
- **Wave 2a calls (from the PRs):**
  - **Claude Files is its own connector** (`claude-files`), off until an admin runs its smoke test and switches it on. While it's off, photos go to Claude as their model copy in the request and PDFs as their text (G6).
  - **PDFs and web fetch:** while web fetch is on, an attached PDF goes into the officer's turn as text with its links neutralized, until one paid probe shows that a PDF document's links don't count as the officer's own input. `room_files read` still returns the PDF itself (G6).
  - **Who's asking** is saved with each message as one line (name, title, department, major, handle). Deleting an account clears its labels (G6, T7).
  - **Stripe charges get their own table** (`StripeCharge`, one additive migration), so a payout's contents and a payment's Stripe side show without calling Stripe live. Webhook events are stored even while their connector is off (otherwise Resend retries and disables the endpoint); Jack's tools still answer from stored data then, saying how old it is. Site traffic leaves out `/admin` pages (T4).
  - **Twitch webhook messages are deduplicated in a table** (`TwitchEventSubMessage`, additive). A live stream isn't closed by Twitch's start-up lag; only `stream.offline` is final (T5).
  - **Documents:** env names are `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_DRIVE_FOLDER_ID`; one Drive job does the change feed, the first walk and the weekly walk; a connector switched off hides its documents everywhere (search, read, tabs) (T6).
  - **Discord:** threads are stored only for opted-in channels, private threads never; a thread's channel is a new nullable column (`DiscordChannel.parentId`) (T7).
  - **Mention mode:** a turn keeps at most the newest 40 side messages (about 20,000 characters) and says how many it left out (T9a).
  - **Meetings:** recording the same meeting twice is refused at apply (one per title per day, under a lock); a new-meeting proposal replaces an earlier one for the same day and type in the room (T10).
  - **Vercel's Hobby plan allows 12 functions per deployment.** Since G5, previews failed at deploy (the build passed, so CI never saw it). Chromium is now traced only into the routes that render, the PDF worker only into those that read PDFs, and no page or route sets its own `maxDuration`: everything runs on the project default, 300 s (the 60 s and 120 s routes too). A test keeps new routes from adding settings (#215).
- **Wave 2b calls (from the PRs):**
  - **Discord posting (T8):**
    - an unconfirmed send is never sent again blind: after its same-nonce retries it's looked for in the channel's history;
    - a post more than 6 hours late is cancelled; switching a rule back on moves its cutoff to now; each run looks back at most 3 days;
    - officers can post directly on Announcements and pause rules; creating, editing and switching on rules, posting channels and role sync are admin-only;
    - role sync adds and removes roles for linked members only, one rule per role, and refuses roles with moderation powers (including through channel overwrites);
    - a ping needs an officer to have asked for it in the room; @everyone and @here need a permission the install link doesn't grant;
    - Twitch go-live is noticed by polling (up to about 5 minutes late), not through Twitch's webhook;
    - Discord event interest counts show on Community → Discord.
  - **Instagram (T9b):**
    - pressing Publish or Add to gallery on a deck page is the officer's approval: it applies directly, audited, after a confirm;
    - the site caps posts at 10 a rolling day;
    - the AI label is an option, off by default (a policy question for Gray).
  - **Automation (T11):**
    - the digest's Discord copy goes through Discord posting (a `digest` post on Announcements);
    - the Teams copy goes through a Workflows webhook connector (`teams-webhook`, off by default);
    - recurring questions and digest summaries share a $10 a month cap (`JACK_AUTOMATION_BUDGET_USD`);
    - notes posted by a job record its key (`JackMessage.jobKey`, one additive migration).
  - **Integration:**
    - T11's migration was renamed to `20261024020500_jack2_note_job_key`, because it had the same timestamp as I2's;
    - the deck page gets the Chromium binary back: publishing renders slides a deck hasn't rendered yet;
    - a flaky event-mirror test was fixed (same-millisecond timestamps).
- **For Gray to sign off, two key exceptions to "read-only or restricted":**
  - Vercel offers no read-only analytics token. A project-scoped, read-write token is used only by a daily snapshot job, with a short expiry (§12.5).
  - Resend's production key stays send-only, and delivery data arrives by webhook instead.

## Test spend
| Date | What | Cost |
|---|---|---|
| 10/23 | Live checks before the full eval: one reply with a deferred tool, web tools on Sonnet and Haiku, the web search question (twice), three attached-file questions with Claude Files on, the planted-PDF question with web fetch on, two direct web probes and the PDF link probe | about $1.00 |
| 10/23 | Paid eval v30, every track on Jack (Sonnet), 120 questions: $4.60 for answers, $5.60 for the judge (Opus) | $10.20 |
| 10/23 | Reruns of the failed questions after fixes (v31, v32, v34, one regrade) | about $2.20 |
| 10/23 | v33: the core track again with every fix in, plus the fixed track questions | $4.46 |
| 10/25 | v35: the core track on Lift ($3.82 answers, $2.64 judge) and Stand ($0.11 answers, $2.07 judge) | $8.65 |
| | **Total, about $26.60: $1.60 over the $25 budget** (the Lift and Stand run was estimated at about $7) | |

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
- **10/22 (evening):**
  - G1 split into three parallel PRs:
    - **#192 G1-data** (me): the schema, three migrations and the role checks.
    - **#193 G1-slots** (agent): interfaces, slots and display kinds.
    - **#194 G1-prompt** (agent): the 2.0 prompt, `run_sql` hardening, CI on `jack-2`, dependencies.
  - The #192 review found two major issues, both fixed:
    - tsvector columns broke `SELECT *`;
    - the audit log leaked officer-applicant review scores.
  - Verified locally as `jack_readonly` with temporary data.
  - Wave-1 briefs written (9 builders); a shared build lock keeps parallel Next builds from exhausting memory.
- **10/22 (later):**
  - #193 and #194 reviewed independently: 12 and 15 findings, all fixed.
  - Merged #192, #193, #194 and follow-up #196. The combined branch passes lint, typecheck and 1,044 tests.
  - **Found on main, fixed separately:** `run_sql`'s name check could be bypassed with `ts_rewrite()`. PR #195 (P1, for Gray).
  - Knowledge seed drafting started (an agent reads Teams and Drive; output stays in the private folder).
  - Wave 1 launched as a workflow: 9 builders in worktrees, each PR then independently reviewed and fixed.
  - **Knowledge seed drafted:** 99 entries plus an index in the private seed folder (not the repo). Topics: the club 5, who does what 27, decisions 14, policies 7, brand 5, sponsors 6, events playbook 7, recruiting 3, services and access 20, calendar 5.
    - **Waiting on Gray:** 26 questions at the end of `_index.md` (conflicts between sources, facts not found, judgment calls).
    - **Note for the memory PR:** the seed's `owner` is a department name. The loader maps it to a person when one clearly owns it, otherwise leaves `ownerId` empty and keeps the department as a tag.
- **10/22 (night):**
  - **Wave 1 done:** 9 PRs built in parallel, each independently reviewed (51 findings: 1 critical, 14 major, 36 minor) and fixed on its branch.
  - Merged #197, #199, #205, #201, #203, #198, #200, #204, #202 into `jack-2`. Conflicts were where tracks meet (slot files, the room client, the room snapshot, the tool context); both sides kept every time.
  - The combined branch passes lint, typecheck, 1,957 tests and the production build; the migration drift check is clean.
  - Browser-checked (light, dark, 390 px): Connections, Scheduled jobs, Proposals, Knowledge, Recruiting, Results, the rooms list with search, and a room opened at a search result.
  - **Before release (gates):**
    - G5: run the production upload path end to end on a working Storage (steps in `tracks/files.md`).
    - G8: confirm live that tool search works with streamed tool input, with `url_sources` naming a deferred tool, and with dynamic filtering on Haiku (eval run).
  - **Noticed, not caused by 2.0:** in dev, an admin page's first load sometimes logs a hydration mismatch in the admin shell's menu button ids. It doesn't repeat on reload, and the admin layout hasn't changed on `jack-2`.
  - Wave 2a launched (9 builders).
- **10/23 (early morning):**
  - **Wave 2a done:** 9 PRs (#206–#214), each independently reviewed (56 findings: 13 major, 43 minor) and fixed. Two fix agents were flagged for "outside writes"; their only outside actions were pushing their own PR branches and posting PR comments, as briefed.
  - Merged all nine into `jack-2`. The hard merge was G6 with T9a (both changed how a turn is built: files and author labels, and mention-mode side messages); both kept, and four tests were updated where the tracks met.
  - The combined branch passes lint, typecheck and 2,973 tests; the migration drift check is clean (three new additive migrations: Discord thread parent, Stripe charges, Twitch EventSub ids).
  - **Found and fixed: previews failing since G5.** Read the deployment error through Vercel's API: "No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan". #215 brings it under the limit (11 with the tracing change alone).
  - **Found on main, fixed separately:** the Stripe webhook logged the whole error on a bad signature, and Stripe's error carries the raw request body. #216 (to main, for Gray).
  - Browser-checked (light, dark, 390 px): Overview cards, Sponsors, Meetings, Action items, Streams, Discord, Payments (Stripe panel), Notifications (Delivery tab), Usage, archived rooms, Knowledge tabs, Connections panels, the privacy page, and a room's new menu. No layout problems. In dev, each admin page's first load logs a hydration mismatch in the admin shell's menu button; the shell hasn't changed, and it's to be confirmed absent from a production build.
  - Wave 2b launched: T8, T9b, T11 and I2 (wave-2a follow-ups).
  - **G5 gate passed** (the production upload path, on local Supabase Storage after fixing its two indexes): all 19 end-to-end checks with `JACK_FILE_STORE=supabase`, a browser upload (cross-origin PUT, register, READY, object in the bucket, removed again), render-check (`store: supabase`), a deck's slides and its PDF, PPTX and PNG exports. The dev-only hydration warning doesn't appear in a production build.
  - **Eval copy ready:** `lsr_eval` migrated to 2.0 and seeded with every track's fake data. The dry run passed 108 of 110 per model; the two Discord ranking questions had checks that passed a non-answer (fixed).
  - **Live checks (G8 and G6 gates), about $1:**
    - A real reply with deferred tools works: tool search together with streamed tool input is accepted.
    - With `JACK_WEB_TOOLS=on`, Sonnet and Haiku requests are accepted: dynamic filtering, `url_sources` naming the deferred `web_links`, and the Console allows web search and fetch.
    - **Found:** with dynamic filtering Claude reads search results in code execution and writes its own links instead of citations, so a search part never listed its pages. Results the answer links to now count as cited. A web search question was added to the eval (it runs only with web tools on).
    - Claude Files: a PDF uploaded at registration went to Claude by file id and the eval's cleanup deleted it from the Files API.
    - **PDF link probe (files.md step 5):** fetching a URL that's only inside a PDF document in the user turn fails with `url_not_in_prior_context`, so the gate that sent PDFs as text while web fetch was on came off. The planted-PDF question passes with web fetch on.
    - **Cost per cold reply:** the cached prefix (system prompt and always-loaded tools) is about 34,000 tokens. A reply after the 5-minute cache lapses pays about 8.5 cents to write it; replies within it read it for about a third of a cent. One web search adds 35,000 to 53,000 input tokens (dynamic filtering reads results in code execution).
  - Security review launched on everything merged (six lenses, each finding verified by skeptics); wave 2b gets its own pass after it merges.
- **10/23 (early morning, continued):**
  - **Review of #218 (the live-check fixes):** 1 major, 8 minor, all fixed before merging:
    - the eval's judge now sees web searches and fetches;
    - link matching starts from each search result's own URL;
    - the PDF probe is a re-runnable script with a control (`scripts/check-jack-web-fetch-documents.ts`).
  - **Security review of everything merged (waves 1 and 2a):** six lenses, each finding checked by skeptics trying to refute it.
    - Access control was clean: every page, server action, webhook, OAuth flow and signed route checks out.
    - 11 confirmed findings (2 major, 9 minor), fixed in three PRs (#222–#224), each independently reviewed.
    - Major: room notes carried model-written text (and its links) back into later turns; links in Jack's replies didn't show where they go.
    - Minor:
      - link neutralizing missed non-ASCII hosts;
      - deck render keys across rooms;
      - full tool input in a log line;
      - Discord purges (thread titles, a race with a running sync);
      - account deletion left emails in delivery events;
      - scheduled emails skipped the daily limit;
      - stale audiences in email proposals;
      - waitlist counts in event changes.
  - **Wave 2b done:** T8, T9b, T11 and I2, each reviewed independently (25 findings: 3 major, 22 minor) and fixed.
    - T8's fix agent stopped before pushing; its eight fix commits were checked and pushed by hand.
    - It also left the shared build lock held for half an hour; the briefs now say how to spot a stale lock.
  - Merged #217, #221, #220 and #219. The combined branch passes lint, typecheck, 3,408 tests and the build; the drift check is clean.
  - Browser-checked: Announcements, Recurring questions, Instagram publishing, Usage (the automation cap), the deck page's new buttons and the Discord page's role sync and posting sections, light and dark, 390 px.
  - **Vercel's Hobby build rate limit** was hit by the night's pushes: recent previews show "build-rate-limit" instead of a result. The function count gets checked again on the release PR.
- **10/23 (morning):**
  - **Security review of wave 2b:** 18 confirmed findings (3 major, 15 minor; a few found by two lenses), fixed in #227 (digest and recurring questions), #228 (Instagram) and #229 (Discord posting), each reviewed.
    - Major: Instagram alt text was posted without showing on the card; role sync never took back the roles it gave when a member unlinked, deleted their account or was purged; a URL glued to a word character got through every link filter.
    - Minor, among others: the digest's Discord copy skipped the posting channels and the last check before sending; the $10 automation cap was checked before spend was recorded; Instagram's daily cap and the posts job had check-then-act races; Cancel and Send again took any value as a post id.
  - Merged #227, #228 and #229. `jack-2` passes lint, typecheck, 3,549 tests, the build and the drift check. Browser-checked Recurring questions, Gallery, Discord and Announcements.
  - **Paid eval, every track on Jack (Sonnet), v30:** 105 of 120 (88%). The eval process didn't exit after its summary, which stalled the loop over tracks for an hour; it exits explicitly now.
  - **Triage of the 15 failures** (#230):
    - Eval checks and harness (8):
      - a bolded count ("**15** forms") never matched its noun;
      - the GM chart check wanted a chart of two zero bars;
      - planted results and sign-up files weren't posted with a message, so `room_files` never listed them;
      - the planted results file named a track and date no round matched;
      - "the last 30 days" for Twitch accepts whole Central days too;
      - "by Friday" asked on a Friday may be asked about;
      - a recurring question's earlier run was dated a minute back instead of a week;
      - and later the email question's guard, which demanded a card although its expectation allows asking first.
    - Jack (prompt and tools):
      - text written between tool calls shows in the room, so no notes to himself;
      - a query's table is the list, even when someone asks for every row;
      - site pages and news are read with `read`, not `run_sql` (which cuts long text and gives no link);
      - a recurring run reports a different number as a change, not a conflict;
      - the digest summary is at most four sentences;
      - counts and bests come from a query or a tool's counts, never by eye; the member roster now carries its own counts (emails, EIDs, LSC status and more);
      - unpaid event fees name their event from the checkout's metadata.
    - Model slips that reruns passed: date windows, a week count in a chart answer.
  - **Reruns:** 10 of the 15 passed after the first round of fixes, and 4 of the other 5 after the second. **v33** (the core track with everything in): 50 of 52 on core (96%, up from 44 of 52), and 5 of the 6 fixed track questions. Its three failures: the email question's guard (fixed), a wrong fastest lap in every-lap (the counts prompt line came after; a last rerun passed), and the digest summary (below).
  - **Still failing:** the digest summary runs about six short sentences where the note asks for at most four (accurate and in the right order). Left for later; the check wasn't loosened.
  - **Reviewed:** #230 was reviewed independently: 7 minor findings, all fixed (event fee names now come from the title each checkout saves, in every payments view; the prompt rules apply only past a handful of rows and when a table shows).
  - **Still seen:** Sonnet sometimes opens with a line like "Let me size it first." before a tool call, despite the prompt. It shows in the room above the tool card; left as is.
  - **Not run:** Lift (Opus) and Stand (Haiku). A full run on all three models doesn't fit the $25 test budget; the runbook's gate says all three, so that's for Gray (run them, or accept Jack only).
  - **Test spend so far:** about $18 of $25.
- **10/25:**
  - **Main's four fixes** (#195 `ts_rewrite`, #190 cron fails closed, #216 the Stripe webhook log, #191 the Sonnet cache price) merged to main, then main into `jack-2`.
    - #191's CI had failed: three tests elsewhere still priced Sonnet cache reads at $0.20. Fixed before the merge.
    - The runbook's predicted conflicts came up and were resolved its way. `jack-2`'s copy of `docs/jack.md` lost #191's two edits, which were put back.
    - The recurring-question estimate test moved from $0.54 to $0.51 a month with the new price.
  - **The release preview deployed** (Vercel's daily limit had reset), so 2.0 fits Hobby's 12 functions.
  - **Eval v35, core track on Lift and Stand:**
    - Lift 49 of 51 (96%). Misses: one answer named no source, and one said "no refunds this year" from a lookup of failed payments only.
    - Stand 38 of 51 (75%). Headline answers right, but slips in the details (a misread checkout count, made-up times or menu paths, no source). Fine for simple recurring counts; analysis stays on Jack.
  - **Gray's release decisions** (runbook section 5):
    - §12(a): the standard terms count.
    - Instagram: AI label off by default, cap 10 a day.
    - The Vercel token and Resend exceptions approved.
    - @everyone given through the install link.
    - Every public Discord channel.
    - "Totals only" stays a convention (officers are trusted).
    - Room notes keep names.
    - Migrations through the workflow.
    - `design.md` and `tracks/` stay; this log is deleted just before the merge.
    - Twitch owner: Gray is finding them.
