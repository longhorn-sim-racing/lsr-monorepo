Docs and env notes for the automation track; folded into docs/jack.md at the end.

# Recurring questions, the weekly digest and "Needs attention" (T11)

Design §11 (all), §1 principle 10 (the $10 automation cap inside the $50), §4.3 (`recurring.upsert`), §7.1 (`propose_recurring`, deferred), §13 (Jack → Recurring questions, Overview "Needs attention"). Code paths are relative to `apps/platform/`.

**New env vars:** `JACK_AUTOMATION_BUDGET_USD` (optional, default 10). `TEAMS_WEBHOOK_URL` was already listed (and already masked by `redactSecrets`); this track is what reads it.
**Migration (additive):** `20261024020000_jack2_note_job_key` adds one nullable column, `JackMessage.jobKey`, and an index (below, "Why a column").
**Setup steps:** only for posting the digest to Teams or Discord (below). Everything else works once the scheduler ticks.

## What's where

| Piece | Where |
|---|---|
| Schedules (four shapes, at most daily), job keys, the digest's settings type | `src/lib/jack/recurring.ts` |
| Field checks (page and proposal) | `src/schemas/recurring-question.schema.ts` |
| Recurring questions: service, a run, page data, cost estimate | `src/server/automation/recurring/` (`service.ts`, `run.ts`, `queries.ts`, `estimate.ts`) |
| Getting a scheduled note answered, retries; posting notes | `src/server/automation/answer.ts`, `notes.ts` |
| The automation cap | `src/server/automation/cap.ts` |
| Running every check at once | `src/server/automation/run-checks.ts` |
| The digest: settings, the three copies, the Discord send, a run | `src/server/automation/digest/` (`settings.ts`, `config.ts`, `render.ts`, `discord.ts`, `run.ts`) |
| Job kinds `recurring.question` and `digest.weekly` | `src/server/scheduler/jobs/automation.ts` |
| Scheduled replies: who answers, what history | `src/server/jack/scheduled-replies.ts` (called from `reply-loop.ts`) |
| `recurring.upsert` | `src/server/jack/proposals/automation/recurring-upsert.ts`, registered in `proposals/kinds/automation.ts` |
| The Teams webhook connector and its fake | `src/server/connectors/teams-webhook/` |
| Checks this track owns | `src/server/automation/checks/automation.ts` (`automation.cap`, `recurring.paused`) |
| Checks added to other tracks' files (they had none) | `checks/groundwork.ts` (`proposals.pending`, `proposals.stale` from `server/jack/proposals/checks.ts`; `connectors.failing` from `server/connectors/checks.ts`), `checks/changes.ts` (`results.missing`, `events.drafts`, `events.low-registration`) |
| Overview card | `src/app/admin/_overview/cards/automation.tsx` |
| Page | `src/app/admin/jack/recurring/` |
| Prompt section and page line; schema notes | `prompt-sections/automation.ts`; `tools/schema-notes-slots/automation.ts` |
| Eval questions; DB check | `scripts/jack-eval/tracks/automation.ts`; `scripts/check-automation.ts` |

## Recurring questions

A question Jack is asked on a schedule in a room, answered as the officer who set it up.

- **The schedule lives only on its `ScheduledJob`** (key `recurring:<id>`, kind `recurring.question`, `singleton: false`). The service creates, changes and deletes the question and its job in one transaction; deleting the question deletes the job (G1's trigger) and deleting the job deletes the question. Its schedule isn't editable on the Scheduled jobs page (G3); admins can still switch it there.
- **At most daily:** officers and Jack pick one of four shapes (every day, weekdays, some days of the week, once a month on the 1st to 28th) at one time of day, Central. `cronFor()` turns it into cron; `isAtMostDaily()` (one minute, one hour) guards turning one on.
- **Jack or Stand only.** The reply to its note is written by the question's persona, whatever the room is set to, so a room switched to Lift doesn't make its automations Lift (`scheduledPersona`).
- **Off by default.** The page's form has "Turn it on now" (off unless ticked); the proposal has `on` (off unless the officer asked to start it).
- **Who it runs as:** `createdById`. From the page, whoever set it up; from a proposal, the officer it was proposed for (or whoever applied it, if that officer isn't one any more). Turning on a question whose owner isn't an officer any more makes the officer who turns it on its owner (the page says so before and after).
- **Estimated monthly cost:** about how many runs a month (a year's runs over twelve) times one run's cost: the question's own last answers when it has some, else recent answers to any recurring question by the same persona (3 or more in 60 days), else a typical run's tokens at the model's prices (about $0.12 for Jack, under a cent for Stand; the cached prompt was about 34,000 tokens on 10/23). Labelled an estimate on the card and the page.

### Each run (`recurring/run.ts`, handed off to `/api/admin/jack/run`, budget 285 s)

1. **Its room is archived:** pause it (job off, `pausedReason`), post a room note ("Paused the recurring question “X”: this room is archived…" with a link to the page), stop.
2. **Its owner isn't an officer any more** (or deleted their account): the same, with that reason.
3. **Automations are over their cap** (or Jack is over his whole monthly budget): skip, with a room note once a month per question ("Skipped the recurring question “X”: automations … have used this month's $10…"), stop.
4. **Ask:** post a scheduled note, `kind: "system", scheduled: true, authorUserId: <owner>, jobKey: recurring:<id>`: "Recurring question “Weekly signups” (set up by Gray): How many people signed up last week?". `lastRunAt` is stamped and any old `pausedReason` cleared.
5. **Answer:** run the room (`runRoom` with the run's own `startedAt`). The reply loop answers a scheduled note in a reply of its own with no web tools (G8); the knowledge tool refuses scheduled requests (I); `fromOfficer` is false. Its history is **short**: the note, and the last note the same job posted with its answer (`scheduledHistoryRows`), never the officers' conversation in the room.
6. **When another run holds the room** (an officer's question being answered), that run picks the note up after its current reply. The job doesn't wait: it moves its own next run up **3 minutes** (`retryJobAt`, only while it's on and not due sooner) and the next run, finding its note still waiting, only gets that one answered (it never asks twice). After **45 minutes** it stops looking; the note waits in the room, which offers Continue (below).

The run log (Scheduled jobs, and "Last runs" on the page) says what happened: "Asked “X”; answered ($0.04) → /admin/jack/<room>?m=<reply>", "…the room is busy with another answer, so it looks again at 9:03 AM CT", "Paused…", "Skipped: automations used this month's $10."

### A waiting scheduled note in the room (G8's open question)

A scheduled note now waits like an officer message: `toMessageView` reports `answered` from `answeredById` and marks it `scheduled`; `stallCandidate` counts it. So a note nothing answered (the retry window ran out, or no run had time) makes the room show "Jack stopped before answering" with **Continue** after the usual 20 s of quiet, and Continue answers it in a scheduled reply. The room doesn't start a run for it by itself (unlike a deck's continue note): the job already tries.

The note's text is a normal room note: its first line is the lead, and the room now links a console path at the end of **any** line of a note's text (`NoteText` per line), which the digest's items use.

### Why a column (`JackMessage.jobKey`)

The short history ("the question and its last answer") needs to know which earlier note belongs to the same question, and the page needs each run's note and reply. Without a key on the note that's only guessable (by time, or by the note's wording, which changes with the title). `jobKey` holds the posting job's key: `recurring:<id>` or `digest.weekly`. It's a plain string, so notes keep it after their question is deleted. The Usage page reads it too (below).

### Jack → Recurring questions (`/admin/jack/recurring`)

Officers only (`requireOfficerPage`); every action checks `requireOfficer` and goes through the service, which audits (`RECURRING_QUESTION`: CREATE, UPDATE, ENABLE, DISABLE, PAUSE (by nobody: a run), DELETE, RUN_NOW).

- A notice when the scheduler isn't ticking (nothing here runs until it does).
- Stats: questions on (and off), the estimated monthly cost of those on, and automations' spend this month against the cap.
- Each question: title, On / Off / Paused, who answers, the question, schedule in words, its room, its owner, the next run, when it last asked, the estimate and this month's cost, the reason when a run paused it, and **Last runs** (up to 5): time, outcome, and a link to the answer with its cost (or to the note still waiting). Turn on/off; a menu with Edit, Ask now (an on question, at the next tick) and Delete (asks first). `?q=<id>` highlights one (the proposal's links, the paused check).
- New question: a dialog (title, room, question, how often and when, Jack or Stand, "Turn it on now").
- The weekly digest's settings (below), and "Preview what it would post now" (`?preview=digest`: the room's copy and the outside copy, from the checks run then).

### `recurring.upsert` (`propose_recurring`, behind tool search)

Set up a question (title, question, schedule; optionally Jack or Stand, a room id, `on`), or change one by its `RecurringQuestion` id (any of those fields). The card shows what changes (a new one: title, question, room, when, who answers, on/off and the estimated cost), the summary says the estimate and that it counts toward the $10. A change snapshots the question; it goes stale when the question changed or was deleted since, or (a new one) when its room was archived since. Apply goes through the same service as the page; field changes and the switch apply in one transaction. Officer permission; not destructive (it posts nothing by itself, and it's off unless `on`).

## The weekly digest

Every track's "needs attention" check (`automation/checks/<track>.ts`, 22 now), run at one moment, rendered from a template.

- **Settings** (`digest/settings.ts`) live on the `digest.weekly` job: its `config` (room, summary on/off, Discord channel, Teams on/off, who saved it and when), its schedule (one day a week at one time, Central; Mondays 9 AM until changed) and its switch. **Off until an officer sets it up.** Any officer sets the room, day, time, summary and on/off; **only an admin changes where it posts outside the console** (Discord, Teams), like the other standing posts. Saving records the officer (`configuredById`, the job's `updatedById`) and is audited (`DIGEST_CONFIGURED` on the job). Turning it on needs a room; an archived room or a Discord channel that isn't a known text or announcement channel is refused.
- **The room** gets the full list as one note: "Weekly digest for Mon, Oct 26 (set up by Gray): 9 things need attention → /admin", then Urgent / Needs attention / For your information, each check with its count and its first 3 items, each line ending with the console path the room links, then the checks that couldn't run. "Things" adds up the checks' counts.
- **Jack's summary:** with the summary on and something to sum up, the note is a scheduled one (`jobKey: digest.weekly`) ending "Jack: sum this up for the officers in a few sentences, most urgent first, using only what's listed here." Jack (always Jack) answers it as the officer who set the digest up, with the same short history (this digest and last week's with its summary), no web tools; the prompt section says to use only what the digest lists. It's a reply, so its cost is automation spend. No summary (and a line saying why) when it's off, when the owner isn't an officer any more, or when automations or Jack's budget are used up. A busy room: the same 3-minute retry as recurring questions.
- **Discord and Teams** get each check's **label, count and console link**, nothing else: never items (they name people), error text or outside text. Discord's copy has every ping off (`allowed_mentions: { parse: [] }`, and no `@` left in it), links in `<>` and `SUPPRESS_EMBEDS`, cut to fit 2,000 characters. Teams gets one Adaptive Card 1.2 with the same lines as links and an "Open the console" button. Only while their connector is on: Discord's (`discord`) and Teams' (`teams-webhook`).
- **At most once a day per place:** the room (a digest note today), Discord (`DiscordPost.dedupeKey` `digest:<day>`) and Teams (an audit entry `DIGEST_POSTED` on `DIGEST` `teams:<day>`). So Run now, or a retry, fills in only what's missing. A run that finds the digest's summary note from an earlier try still waiting (within the 45-minute retry window) uses that try's day, so a retry that runs past midnight doesn't post the digest a second time. Each outside post is audited (`DIGEST_POSTED`, by nobody).
- **One place failing doesn't stop the others;** the run fails at the end saying which, with the rest in its log.

### Sending to Discord (`digest/discord.ts`)

The discord-post track owns posting; its posting function wasn't merged when this was built, so the digest sends through the pieces T8 builds on: a `DiscordPost` row (`source: "digest"`, content exactly the body sent), T7's REST client (`client.rest.request`: rate limits, timeout, errors without the token), and Discord's guards. The row is created as `SENDING` (or taken over from `FAILED`, or from a `SENDING` claim over 10 minutes old) with a conditional update, so two runs never both send; the send carries the row's `nonce` with `enforce_nonce`, so a retry gets Discord's existing message back instead of a second post (within Discord's nonce window); a failure is kept on the row, redacted. **When T8 lands,** replace the body of `sendDigestToDiscord` with T8's posting function (same inputs); its Announcements page should show `source: "digest"` posts.

### Teams (`connectors/teams-webhook/`)

A Workflows webhook ("Post to a channel when a webhook request is received"), separate from the `teams` connector (Graph reading, which waits on UT IT). `TEAMS_WEBHOOK_URL` is the flow's URL; the URL itself is the secret (`sig`), so only its host is ever shown, errors carry the status and Workflows' error code only, and no auth header is sent ("Anyone" mode). The client refuses a URL that isn't https on `*.logic.azure.com` or `*.api.powerplatform.com` with `/workflows/` in its path. **Its smoke test posts one short test card** ("LSR officer console: connection test"): a webhook has nothing to read, so a post is the only live check. Every post (the digest's and the smoke test's, `postRecorded`) records its outcome on the connector (`recordConnectorError` / `recordConnectorSync`), so a deleted flow, a rotated URL or a blocked connection shows as failing on Connections, in the `connectors.failing` check and on the digest form. At most 25 posts per 5 minutes per connection; the digest posts once a week.

## The automation cap (`automation/cap.ts`)

$10 a month (`JACK_AUTOMATION_BUDGET_USD`) inside Jack's $50, by Central Time month. Automation spend is exactly what the Usage page counts as automation: replies to a scheduled note (recurring questions and digest summaries; each scheduled note is answered alone) plus side jobs in `JackUsage` other than Stand naming rooms (none yet). Recurring questions check it before asking, the digest before asking for its summary; both also stop when Jack's whole budget is used up (his reply would only be the "budget used up" notice).

- **Usage page (T9a's):** a stat "Automations" with a meter against the cap ("Cap reached: recurring questions and digest summaries pause until the 1st"), from the page's own data (`UsageOverview.automation`); "By officer and automation" now splits **Weekly digest summaries** from **Recurring questions** by the note's `jobKey`. No `JackUsage` automation rows exist (the digest's summary is a reply), so T9a's "Automation: <job>" label isn't used yet.
- **Checks:** `automation.cap` (from 80% of the cap, urgent at it) and `recurring.paused` (questions a run paused, with why).

## "Needs attention" on the Overview

The first card (spanning both columns): every check, run live when the page loads (`runDigestChecks`, each with a 10 s limit, one failing never breaking the rest), most urgent first, each with its count, a link, and its first 3 items; the checks that couldn't run are named at the bottom (never their error). A link to the digest's settings. "And N more" (here and in the digest's room note, `moreThanShown`) is the check's count minus what's shown. A check whose count is in other units than its items sets `moreItems` (how many items it left out) so the line counts items: the bounce check (counts addresses, lists emails), overdue action items (counts items, lists owners) and unreviewed applications (counts applications, lists teams).

### The checks added for the digest

| Check | Owner file | What |
|---|---|---|
| `proposals.pending` | groundwork | Pending proposals (not expired), oldest first, each linking to the reply that proposed it; a warning once one has waited more than 3 days |
| `proposals.stale` | groundwork | Proposals that went stale in the last week, or expired unswept (info) |
| `connectors.failing` | groundwork | Switched-on connections whose last error is newer than their last sync, except those with their own check (Drive, SharePoint, Teams, Twitch, Instagram insights) |
| `results.missing` | changes | The Overview's "Results missing" rule (`missingResultsWhere` now in `lib/events.ts`, shared with the Overview panel); a warning after a week |
| `events.drafts` | changes | Drafts starting in the next 14 days (warning within 7), then drafts whose date passed in the last 14 |
| `events.low-registration` | changes | Published events in the next 7 days with registration on and a cap, under half full (warning: within 2 days and under a quarter) |

## Eval (`scripts/jack-eval/tracks/automation.ts`)

The harness gained **scheduled questions** (`Question.scheduled`): asked as a scheduled room note from the officer, answered as a scheduled reply (no web tools, `fromOfficer` false); `before` exchanges are then the same job's earlier notes and answers. Two harness fixes came with it: earlier answers carry their model now (the history left out a reply without one as a notice, so `before` answers never reached the model), and `fakeCalls: []` means the dry run calls no tool.

| Question | Group | What it checks |
|---|---|---|
| `propose-recurring-new-accounts` | propose | A `recurring.upsert` proposal for Mondays at 09:00, nothing applied, no recurring question made |
| `recurring-run-new-accounts` | everyday (scheduled) | Asked as the note, with last week's answer before it: the week's new accounts from the data (any fair reading), nothing proposed, no knowledge saved |
| `digest-summary-factual` | analysis (scheduled) | Asked as the digest's note over a fixed, made-up week: no tool calls, no number the digest doesn't have, no outside links, short, the urgent item (Jack's budget) mentioned; the judge gets the digest's facts |

No fake data is seeded: the run question reads the eval copy's accounts, and the digest is a fixture in the question. The dry run passes on a copy of `lsr_eval` (`--track=automation --only=jack`).

## Trying it locally (no Claude API, nothing paid)

- `NODE_ENV=production pnpm exec tsx scripts/check-automation.ts` runs a recurring question through the real reply loop (a scripted fake Claude) against the local database: the note, the persona, the short history, the cost counted as automation spend, a busy room and the retry, the cap, both pauses, the delete trigger, `recurring.upsert`'s prepare and apply, every registered check against the schema, and the digest (note, summary, once a day). It deletes what it wrote.
- **The page:** start the app, open Jack → Recurring questions, set up a question in a room and turn it on, then `pnpm --filter @lsr/platform jack:tick --job recurring:<id>` (the key is on System → Scheduled jobs). Without `ANTHROPIC_API_KEY` the reply is Jack's "isn't connected" notice, which is enough to see the flow. A run inside `jack:tick` runs in-process (no hand-off).
- **The digest:** set it up on the page (a room, summary on), then `jack:tick --job digest.weekly`. To try Teams against the fake: `JACK_FAKES=teams-webhook` and `TEAMS_WEBHOOK_URL=https://prod-00.fake.logic.azure.com/workflows/lsr-fake/triggers/manual/paths/invoke?api-version=2016-06-01&sig=fake` in `.env.local`, `pnpm jack:fakes`, switch "Teams digest posts" on in Connections (its smoke test posts to the fake), tick "Post to Teams" as an admin, run the job, then `curl http://127.0.0.1:3999/teams-webhook/_fake/cards`. Discord's fake has no create-message route until T8 adds it, so a Discord post fails locally (the row says so); the unit tests use a test-only fake for it.
- Unit tests: `src/lib/jack/recurring.test.ts`, `src/server/automation/**/*.test.ts`, `src/server/jack/scheduled-replies.test.ts`, `src/server/jack/proposals/automation/recurring-upsert.test.ts`, `src/server/jack/proposals/checks.test.ts`, `src/server/connectors/checks.test.ts`, `src/server/connectors/teams-webhook/client.test.ts`, the page's `actions.test.ts`, the card's test, `scripts/jack-eval/tracks/automation.test.ts`, plus additions to `usage.test.ts`, `messages.test.ts`, `room-state.test.ts`.

## Setup for Gray

1. **Nothing for recurring questions** beyond the scheduler ticking (G3's setup). Officers set them up on Jack → Recurring questions.
2. **The digest in a room:** any officer, on the same page: pick the room, day and time, keep or drop Jack's summary, turn it on.
3. **The digest on Discord** (admin): Discord connected (T7's setup), and the bot allowed to post in the channel (T8's install permissions include Send Messages). Pick the channel in the digest's settings. A text or announcement channel only; the officers' channel is the natural one.
4. **The digest on Teams** (admin, needs Workflows allowed in UT's tenant, UNVERIFIED):
   1. In the Teams channel: ⋯ → Workflows → "Post to a channel when a webhook request is received". Who can trigger: **Anyone**. Add a co-owner to the flow, or it stops when its maker leaves the club.
   2. Copy the URL it shows into Vercel as `TEAMS_WEBHOOK_URL` (Production, **Sensitive**), and redeploy.
   3. System → Connections → "Teams digest posts" → Run smoke test (it posts one test card to the channel), then switch it on.
   4. Tick "Post to Teams" in the digest's settings.
5. Optional: `JACK_AUTOMATION_BUDGET_USD` to change the $10.

## Release

1. The migration `20261024020000_jack2_note_job_key` goes to production with the other 2.0 migrations, before the code (it's additive; old code never reads the column).
2. After the merge, the digest and every recurring question are off until officers turn them on; "Teams digest posts" ships off like every connector.
3. Turn on the scheduler first (G3). A recurring question or the digest posts nothing while it isn't ticking, and the page says so.

## Decisions made here (for the build log)

- **The digest's summary is a reply to the digest's note,** not a side call: Jack writes it with his own prompt and tools, so the eval can test the real path, it counts as automation through the same rule as recurring questions, and officers can ask about the digest in the room afterwards (the note and summary are in the room's history).
- **A waiting scheduled note shows in the room as waiting** (Continue offered), without the room starting a run by itself.
- **Room busy: retry in 3 minutes, for 45 minutes,** never asking twice.
- **Skipped at the cap with one room note a month per question,** and also when Jack's whole budget is gone.
- **A question pauses itself** when its room is archived or its owner isn't an officer, with a room note; turning it back on takes it over.
- **Digest: officers set the room, time and summary; admins set Discord and Teams.** Once a day per place.
- **Discord posting goes through a thin sender** on `DiscordPost` and T7's client until T8's posting function lands (a deviation: the brief said "through T8's posting surface").
- **Teams has its own connector** (`teams-webhook`), whose smoke test posts one test card.
- **One new column, `JackMessage.jobKey`** (additive migration).
