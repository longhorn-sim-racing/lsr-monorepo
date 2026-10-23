# Jack

Jack is the officer chat agent in the admin console (**Admin → Jack**; #161, and Jack 2.0 in #188). Officers ask about the club in shared rooms and get plain answers, tables and charts back. He reads the club's data and the outside services the club connects (Discord, Stripe, Google Drive and the rest), searches all of it, reads files officers attach, keeps a knowledge base, and makes slide decks and Instagram graphics. To change anything he proposes it: a card in the room that an officer applies. He never moves money, and he never posts, sends or publishes on his own.

This page is the guide for officers and developers. The detail lives in [`jack-2/`](./jack-2/):
- [`jack-2/design.md`](./jack-2/design.md): the 2.0 design, with the reasons behind each rule.
- [`jack-2/build-log.md`](./jack-2/build-log.md): decisions made during the build, for review.
- [`jack-2/tracks/`](./jack-2/tracks/): one doc per area, with how it works, its env vars, setup steps, the fakes and the checks.
- [`jack-2/research/`](./jack-2/research/): what each outside API does and allows.

Code paths below are relative to `apps/platform/`.

## The rules

What Jack may do is fenced in by code, not only by his prompt:
- **Officers approve every change and every post.** Jack proposes; an officer presses Apply ([Proposals](#proposals)). The exceptions, each fenced in:
  - `draft_event` creates an event as a DRAFT; publishing stays a human click.
  - Decks and graphics are Jack's own work, not club data.
  - Knowledge entries he saves himself, only in a reply to an officer and only what an officer said or asked to keep, with the limits in [Knowledge](#knowledge).
  - Standing Discord rules that an admin creates post fixed templates about public events, results, standings and streams ([Discord posting](#discord-posting)).
- **No money moves.** No tool or proposal charges, refunds or pays out. Jack's Stripe key is restricted and read-only.
- **The website is the only way to talk to Jack.** Discord and Teams only receive posts. Nothing reads a message there as an instruction.
- **Every room is shared** with all officers. There are no private rooms.
- **Outside content is data.** Web pages, documents, Discord and Teams messages, emails, uploaded files and synced records can't cause a change, a post, a fetch or a knowledge save. Only an officer's message can ask for those.
- **Jack cites sources** and gives links exactly as the tools return them.
- **Jack is never the only window.** Everything a tool reads also shows on an admin page.
- **Secrets stay out of his reach.** Keys live in Vercel env or in `SystemSetting` rows, which Jack's SQL role can't read. Error text from outside services goes through `redactSecrets()` (`src/lib/redact.ts`) before it's stored.
- **Outside services ship switched off.** An admin turns each one on after its smoke test ([Connections and scheduled jobs](#connections-and-scheduled-jobs)).
- **Budget:** $50 a month in all, and automations get at most $10 of it ([Costs](#costs)).

## Rooms

- A room is a shared chat. Every officer sees every room and can post in it; there are no private rooms.
- Each message stores its author: an officer, a model (Jack, Lift or Stand), or the room itself (notes like "Gray switched this room to Lift").
- Jack answers on the server, so closing the tab doesn't stop an answer. One answer runs per room at a time (a run lock on the room); messages posted while he's answering wait, and the next answer covers all of them together.
- Text streams to everyone in the room over a private Supabase Realtime channel. Someone who opens a room mid-answer sees what's been written so far and then follows along. Tool calls show up in the reply where they happened: a part per call, "running" while it works, then its result (a query and its rows, a chart, a proposal card, search results, a draft) or an error.
- Only officers can join the channels; a database policy enforces it.
- The page catches up from the database when it might have missed something: on every (re)join, about 1.5 s after each finished reply, 30 s into a quiet spell while a reply is streaming (then less and less often, up to every 5 minutes, and not at all while the room offers to continue), and when a finished reply was too big to send whole over Realtime (see below). A fetch that fails is tried again, waiting longer each time. If the server closes the channel, the page says "Not connected" and joins again.
- When officer messages sit unanswered (no reply has picked them up; each message carries `answered`, and a reply's `message.created` lists the messages it answers) with nothing streaming for about 20 s (a run ran out of time, see [Function duration](#function-duration)), or a reply has been "answering" with no news for over 6 minutes (the run writing it died), the room shows "Jack stopped before answering" (or "partway through an answer") with an **Ask him to continue** button. It starts a run like posting does (`resumeJackRoom`, officers only). If a run still holds the room it says so instead; a dead run's lock is taken over once it's stale, which closes its half-written reply as an error and then answers what's waiting. A recurring question's note that nothing answered shows the same way.

### Who's asking

Posting saves the officer's profile with the message as one line (`JackMessage.authorLabel`, `src/server/jack/author-label.ts`): `Gray (Technology Director · Technology · CS) [@gray-marshall]`. Jack reads each officer line that way, so he knows the asker's role and handle. Past messages keep the label they were posted with. Tools that need an officer take a handle; "me" and "mine" count only when one officer posted in the turn. Deleting an account clears its labels.

Officer profiles (department, board seat, "what I work on") are edited on the profile editor's "Officer profile" step and on **Members and roles → edit**. `scripts/sync-officer-badges.ts` fills department and board seat from the roster on `/about`.

### The room menu

The "…" in a room's header (`src/components/jack/room-settings.tsx`; server side `src/server/jack/room-settings.ts`):
- **Pin room to the top.** Pinned rooms sort first in the rooms list and the rail beside a room. Pins are shared, like rooms.
- **Answer only when mentioned** (mention mode). Jack answers only messages that mention `@Jack` (or the persona answering the room, like `@Lift`). Other messages are saved with `expectsAnswer = false` and start no run. The next mention's reply takes the messages since the last reply as context, marked "(not addressed to you)", and answers only what's addressed to Jack. A turn keeps at most the newest 40 of them (about 20,000 characters).
- **Archive room.** The room turns read-only for everyone, live: no posting, renaming, persona switch, ratings or proposal Apply/Discard, and no Jack run starts in it. **Unarchive** brings it back; a message left waiting is answered by the next run after that.

Each change posts a room note and is audited (pins are audited without a note).

The rooms list (`/admin/jack`) has **In use** and **Archived** views (`?view=archived`) and a search box over room names and every message (`?q=…`). A result opens the room at that message (`/admin/jack/<room>?m=<message>`): the page loads the messages around it and highlights it.

### Ratings

Thumbs up or down under each finished reply, one per officer per reply (`JackFeedback`). A thumbs-down asks for an optional note ("What was wrong?"). Ratings and notes show on the [Usage page](#costs); a thumbs-down with a note is marked as an eval candidate.

### Files in rooms

Officers attach files with the composer's attach button, paste or drag and drop: up to 10 per message, 25 MB each.
- **Taken:** JPEG, PNG, WebP, GIF; PDF; CSV, XLSX; JSON; TXT, Markdown; VTT (transcripts); DOCX.
- **Refused:** SVG, HTML and XML, macro files, archives, programs, and HEIC (export it as JPEG).
- The browser uploads straight to storage with a signed link for one path (`createJackUpload`). `POST /api/admin/jack/files/[id]/register` then checks the file: its size and type, its first bytes against its type, the ZIP layout of Office files (macros and zip bombs refused). It makes a photo copy (JPEG, metadata stripped, at most 2000 px) and extracts the text, with caps on size, rows, pages and time.
- Files are served only to officers, by id (`GET /api/admin/jack/files/[id]`), with headers that stop the browser running them.
- **What Jack sees:** every officer turn lists its files (`[Attached: "Sponsor packet.pdf" (PDF, 2.1 MB, 12 pages; id …)]`). The turn he's answering carries them: photos as images, PDFs as documents (or their text past the turn's limits), other files as a short summary. Links in summaries and file names are neutralized (`[link to evil[.]example]`), so a link planted in a file can't be fetched. `room_files` lists the room's files and reads one again by id.
- **Claude Files** (connector `claude-files`, off until an admin switches it on): photos and PDFs are uploaded once to Anthropic's Files API and sent by id, instead of in every request. Uploads expire after 30 days and are made again when needed. While it's off, photos go inline and PDFs as text.
- **Cleanup:** the `files.cleanup` job deletes uploads that never finished (24 hours) and files never posted (7 days). Posted files and meeting transcripts stay.

Details: [`jack-2/tracks/files.md`](./jack-2/tracks/files.md).

## Personas

| Name | Model | Effort | Used for |
|---|---|---|---|
| Jack | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | medium | Every answer, by default |
| Lift | Claude Opus 5.5 (`claude-opus-5-5`) | high | Long, multi-step analysis. Set per room with **Answered by** ("Lift (slower, higher cost)"); it stays until someone switches back, and the switch is posted in the room. About twice Jack's price per token; in the October eval it was no more accurate than Jack, about twice as slow and three times the cost per answer |
| Stand | Claude Haiku 5.5 (`claude-haiku-5-5`) | medium (low for side jobs) | Quick, simple questions, set per room with **Answered by** ("Stand (simple tasks)"), at about a twentieth of Jack's price per token. Also the side job of naming a new room after its first answer (`STAND_SIDE_JOB`) |

The names are the joke; the answers stay plain. Models and effort live in `src/server/jack/models.ts`. These models always think before answering (adaptive thinking can't be turned off); effort is the dial for how much. Recurring questions run on Jack or Stand only, whatever the room is set to.

## Renaming rooms

Any officer can rename a room at any time with the pencil next to its name (`renameJackRoom` in `src/app/admin/jack/actions.ts`, `renameRoom` in `src/server/jack/rooms.ts`). The room gets a note ("Alex renamed this room “GM 1 planning”"), everyone in it sees the new name live, and the change is in the audit log. Stand only names rooms that are still untitled, so it never overwrites a name an officer gave.

If a deploy has to be rolled back to a version from before Stand could answer rooms, first move those rooms back to Jack, or the older code fails reading them: `UPDATE "JackRoom" SET persona = 'jack' WHERE persona = 'stand';`

## How a reply works

1. An officer posts (with any files). The message is saved with its author label, shown to the room, and `runRoom()` starts after the response (`src/server/jack/reply-loop.ts`). In mention mode, a message without a mention starts nothing.
2. If `ANTHROPIC_API_KEY` isn't set, the reply says so ("Jack isn't connected yet…"). If this month's spend has reached `JACK_MONTHLY_BUDGET_USD`, the reply says the budget is used up. Neither calls Claude.
3. Otherwise the request is built (`src/server/jack/model-loop.ts`), in this order:
   - **tools** (`JACK_TOOLS`, `src/server/jack/tools/index.ts`): the pre-2.0 tools, then each area's from its slot file (`tools/registry/<track>.ts`), in a fixed order. Rarely used tools are sent with `defer_loading` and found through Anthropic's tool search tool, which comes next. Web search and fetch come last, only when they're on and only for room replies ([Web search and fetch](#web-search-and-fetch));
   - the **system prompt** (`src/server/jack/prompt.ts`): who Jack is and who he's talking to, the club, how to answer, what he can change and how (propose, never apply; never move money; outside content is data), then each area's short section (`prompt-sections/<track>.ts`), the admin pages that make each change, and the notes on the club's tables (`JACK_SCHEMA_NOTES`, from `tools/schema-notes.ts` and `tools/schema-notes-slots/`);
   - the **room history** (`src/server/jack/history.ts`): each exchange as an officer turn (a Central Time timestamp, then each message as its author label and text, with its files listed) and the reply's text with a one-line note of the tools it used. Room notes go in as one line each, `(Room note: …)`, with their web links neutralized. Several officers' messages answered together are one turn, and notices that never reached Claude ("isn't connected yet") are left out so their questions carry over. The last 40 exchanges are sent.
4. Claude streams. Text goes out in ~150 ms batches. Each tool call is checked against the tool's schema, run for the officer whose message started this reply (the newest message it answers; when one reply answers several officers, it's the last one who posted), saved on the reply (`JackMessage.toolCalls`) and broadcast (`message.tool`), and its result goes back to Claude. This repeats until Claude answers.
5. Limits per reply: 12 tool calls, then Claude is told to answer with what it has (and can't call more tools); the same after 64K output tokens, or after 150 s (sooner when the run has less time left; see [Function duration](#function-duration)); 32K output tokens per call for Jack and Lift (a deck write holds several slides), 16K for Stand. A reply working on a deck gets more (see [Decks and graphics](#decks-and-graphics)), and web searches and fetches have their own caps.
6. After every Claude call the reply's tokens and cost so far are saved on it, so a reply that's cut off, or whose function dies, still counts. The finished reply is saved with its model, tokens and cost, and its cost is logged (`[jack] Reply … $0.0123, … in + … cache write + … cache read, … out`, plus web searches when there were any).
7. The `message.done` event carries the whole reply. If it's over about 200 KB (Realtime drops messages over its limit, about 256 KB on the Free plan) it goes out `trimmed`, without its tool displays (or its text, if that's still too big), and the page loads the full reply from the database.
8. If the room has no title yet, Stand names it in 2 to 5 words in the background and posts "Stand named this room “…”".

A **scheduled** reply (to a recurring question or the weekly digest's note, [Automation](#automation)) is answered on its own, never together with officer messages. It gets no web tools, can't save knowledge, and sees a short history: the question and its last answer.

What the room sees when something goes wrong:

| What happened | The reply |
|---|---|
| Claude's safety checks declined | "I can't help with that one…" (status done). A partial answer before the decline is taken back, for viewers too: a delta marked `replace` swaps the text so far for the new text |
| A streamed tool call came through garbled | The call is asked again (twice at most). Its text is taken back the same way, so it isn't shown twice, and its tool part shows "Didn't run". The log line is fixed text (the room and the attempt), never the raw input |
| An answer cut off at the length limit | The text so far plus a note. A tool call that was cut off isn't run |
| The API failed (rate limit, overload, bad key, network) | The text so far plus a plain explanation, status **error**. The Console's spend limits get their own message |
| The answer ran out of time | "This answer was stopped before it finished", status **error** (see [Function duration](#function-duration)) |
| A tool failed | The part shows the error; Claude sees it and usually works around it |
| Saving a partial reply mid-stream failed | Nothing: it's logged and the stream goes on; the final save writes the whole text |

**Links in replies** (`src/components/jack/reply-text.tsx`) are checked before they're drawn: site paths open in place only while they stay on this site; a web link opens in a new tab with the whole URL on hover and its host after it, and a "sends data" flag when the link would hand a site data (a long query, an email address, a user name before the host). Meeting agendas and summaries use the same component.

### Refusals

Sonnet 5.5 and Opus 5.5 run safety classifiers that can decline a request (cyber, bio and a few other categories), occasionally on harmless club questions. Replies opt into Anthropic's server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a declined request is retried on the model Anthropic recommends for that category, inside the same call. The fallback attempt is billed at that model's rates, and the cost math prices each attempt by the model that ran it. Not every category is retried (from Sonnet 5.5, only cyber and frontier_llm declines are); then, or when the fallback model declines too, the room sees the refusal message. Haiku has no server-side fallback: a declined room answer from Stand shows the refusal message, which suggests switching the room to Jack, and a declined room name just leaves the room untitled.

### Prompt caching

Every request starts with the same tools and system prompt, with a cache breakpoint at the end of the system prompt, and automatic caching on the conversation after it. Cache reads cost a tenth of normal input (less on Opus), so a room's follow-ups mostly pay for what's new. This stays cacheable because:

- the system prompt has no dates, names, counts or connection status in it (the time and who's asking are in each officer turn instead; whether a service is connected is in tool results), and the tools never change order. The tool list changes only with the web tools switch, and between room and scheduled replies;
- the history is rebuilt from the saved messages the same way every time, so each request's history is the previous one plus the new exchange. The 40-exchange window moves its start in steps of 10, so it stays put for several turns;
- within one reply, each Claude turn goes back exactly as it came (thinking, tool search results and web results included), with its tool results appended after it.

Thinking blocks are only ever sent back within the reply that made them. Earlier replies go back as text, so no thinking block is replayed into an edited conversation (which these models reject). Requests set `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`), so if a bug ever did edit the history, the reply would continue without that thinking instead of failing; it's logged as a warning.

The cached prefix (system prompt and always-loaded tools) is about 87,000 characters. With the API's own instructions for tool search added, a cold reply wrote about 34,000 tokens to the cache in the October live checks. `src/server/jack/prompt-size.test.ts` holds the prefix to 100,000 characters and every area to its own budget; `pnpm --filter @lsr/platform exec tsx scripts/jack-prompt-size.ts` prints the table.

## What Jack reads

### The core tools

The typed tools carry the club's definitions, so Jack should rarely need his own SQL. After the October eval (see [The eval](#the-eval)) they cover what officers asked for most:

- `club_members` lists a **roster**: the officers with titles, emails and EIDs, handles, department, board seat and what they work on, or every member (optionally by join date) with email, EID, join date, roles, events registered for, check-ins, races driven, this LSC season's entry status and money paid.
- `member_activity` ranks members by registrations, check-ins and races driven.
- `lsc_entries` gives each driver's school (the form leaves it blank for UT Austin), experience, equipment and form notes, and counts forms by school and experience.
- `events_overview` says whether an event takes registrations and check-ins at all (settings, not whether they're open now), how full it was, and can list only events that had check-ins.
- `payments_summary` lists the people who started a checkout and never paid for that item (`unpaidCheckouts`), the club's definition.
- `standings` and `audit_log`. The audit log tool hides recruiting entries about officers' own applications.
- `chart` draws rows it's given. `draft_event` creates a DRAFT event and returns the whole link, so the reply never guesses the site's address.
- `draft_text` (always loaded) returns an email, agenda, caption or other text as a copyable card. It never sends. An email address or phone number in a draft must come from an officer's message in the room, or be the club's own.
- Behind tool search: `recruiting_pipeline` (a round's applications per team and status, unreviewed ones, scores, reviewer load; submitted applications only, and officers' own applications show only that they applied) and `race_performance` (best and average laps, consistency, incidents, positions gained, trends and head-to-head, from uploaded results, with the data's limits).

**Times.** Every tool gives times in Central time with the weekday ("Fri 2026-10-09 16:49 CT", `ct()` in `tools/time.ts`), so no model works a weekday out. Prisma returns `date`, `timestamp` and `timestamptz` columns all as Dates, so `run_sql` also selects each row as `row_to_json` to tell them apart: the model gets Central times and plain dates, and the room's table gets UTC ISO (which it shows in Central) and plain dates. `run_sql` can't tell a time the query itself converted to Central from a stored UTC one, so a query that leaves an `AT TIME ZONE 'America/Chicago'` conversion as a timestamp gets a note to select times as stored (or cast the bucket to `date`).

**Room tables** show up to 200 rows, as many as `run_sql` returns, so a whole member list fits.

### Search and read

`search` (always loaded) is one full-text search over every source (`src/server/jack/search/`), merged by rank, with links. `read` opens one result by type and id, a page at a time (`offset`, `maxChars`, with an outline of headings), or only the passages matching a `query`.

| Source | What | Notes |
|---|---|---|
| `knowledge` | Knowledge entries | Archived entries left out. Gives the entry's age and whether it's reviewed |
| `documents` | Google Drive and SharePoint documents | Only from sources that are switched on |
| `rooms` | Messages in Jack rooms | Officers' messages and room notes. Jack's own answers only when asked, labelled "Jack's earlier answer (not a source)" |
| `site` | The public site | Public posts, content pages, public events (never their meeting links), gallery albums, Instagram posts. `read` fetches any public page by path, with no cookies, never `/admin`, `/api`, `/account` or `/auth` |
| `teams` | Teams channel messages | Only while the `teams` connector is on |
| `discord` | Messages in opted-in Discord channels | Searched live through Discord's API; nothing is stored, and the room's link shows no snippet |

The index is one side table, `JackSearchDoc`, kept current by database triggers on room messages, knowledge entries, documents and Teams messages. Jack's SQL role can't read it; search goes through the tools.

### Outside services

Each outside service is a connector (`src/server/connectors/`). Its sync jobs and webhooks copy what Jack needs into the club's own tables, and his tools read those copies and say how fresh they are, or that the service isn't connected. Discord search is the one live read. The service tools below (all but `search` and `read`) are behind tool search.

| Source | Connector | Tools | Kept current by | Where officers see it |
|---|---|---|---|---|
| Discord | `discord` | `search`, `read`, `discord_activity`, `discord_polls` | `discord.sync` (10 min), `discord.rescan` and `discord.members` (hourly), `discord.prune` (daily). Metadata only: no message text is stored | Community → Discord, Overview |
| Twitch | `twitch` | `twitch_stats` | EventSub webhook (`/api/webhooks/twitch`), `twitch.live` (every minute), `twitch.daily`, `twitch.token-check` | Content → Streams (where an admin connects the club's Twitch account), Overview |
| Instagram insights | `instagram-insights` | `instagram_insights` | `instagram.account-daily`, `instagram.post-insights` (hourly) | Content → Instagram (Insights) |
| Stripe | `stripe` | `stripe_overview` | `stripe.sync` (daily), plus payout and dispute events on `/api/stripe/webhook` | Money → Payments (Stripe panel) |
| Email delivery | `resend` | `email_delivery` | Resend's webhook (`/api/webhooks/resend`); `email-events.prune` keeps 12 months | System → Notifications (Delivery), Recruiting → Emails |
| Site traffic | `site-traffic` | `site_traffic` | `site-traffic.snapshot` (daily; public pages only, UTC days) | Overview (Site traffic card) |
| Google Drive | `google-drive` | `search`, `read` | `google-drive.sync` (15 min; one shared folder, read-only service account) | Content → Knowledge → Documents |
| SharePoint | `sharepoint` | `search`, `read` | `sharepoint.sync` (hourly) | Content → Knowledge → Documents |
| Teams messages | `teams` | `search`, `read` | Graph change notifications (`/api/webhooks/graph`), `teams.subscriptions`, `teams.sync` (daily) | Content → Knowledge → Teams messages |

Club records added in 2.0 are read the same way, from their own pages: sponsor prospects (`sponsors_list`; Club → Sponsors), meetings, decisions and action items (`meetings_list`; Club → Meetings, Club → Action items).

Privacy rules that hold for these sources:
- **Discord** keeps no message text: only who posted, when, the length, attachments, replies and poll totals (never voters), for opted-in channels. Pages and tools show totals only. An admin can purge a member's records on request (Community → Discord, or a member's edit page); a purge also removes the titles of threads they started, and the sync never collects them again. Members link their Discord account on their profile (`identify` only; the token is revoked straight away).
- **Email delivery** keeps the recipient and outcome, never a click's IP or browser. Deleting an account deletes its delivery events.
- **Recruiting:** Jack's tools and his SQL role never see draft applications, or reviews, scores and decisions on an application from an officer or admin.
- Drive and SharePoint deletions null the stored text; a Teams message deleted in Teams keeps only who wrote it and when.

Area docs: [Stripe, email and traffic](./jack-2/tracks/sources-a.md), [Twitch and Instagram insights](./jack-2/tracks/sources-b.md), [documents](./jack-2/tracks/documents.md), [Discord reading](./jack-2/tracks/discord-read.md), [club data](./jack-2/tracks/club-data.md), [sponsors and meetings](./jack-2/tracks/sponsors-meetings.md).

### Web search and fetch

With `JACK_WEB_TOOLS=on`, room replies get Anthropic's server tools `web_search_20260209` and `web_fetch_20260209` (`src/server/jack/web-tools.ts`). Unset, they're off. The Anthropic Console must allow both (Settings → Capabilities), or every request fails.

- **What web_fetch may open:** links in officers' messages, and results of earlier searches and fetches in the same reply. No client tool's results count except `web_links`, which returns only links earlier replies found on the web. So a link inside club data, a document, a Discord message or a query row can never be fetched. Everything the system puts in an officer's turn (file names and summaries, room notes) has its links neutralized.
- **Limits:** per API call 5 searches, 3 fetches and about 10K tokens of a page. Per reply, Jack is told to wrap up after 8 searches or 5 pages (a soft cap, checked as each call ends). Search results are localized to Austin, Texas. The prompt forbids member data in search queries and URLs.
- **Scheduled replies never get web tools.**
- The room shows each search with its query and the results the answer cites, and each fetch as "Read fia.com".
- Each search costs $0.01 plus the tokens its results add (35,000 to 53,000 input tokens in the live checks).

Details: [`jack-2/tracks/groundwork.md`](./jack-2/tracks/groundwork.md), "Model loop 2.0".

### Jack's own SQL

Two tools run Jack's own SQL, as `jack_readonly` through `JACK_DATABASE_URL` (`src/server/jack/sql-client.ts`):

- **`run_sql`**: one `SELECT` or `WITH … SELECT` he writes. Each runs in its own `READ ONLY` transaction with a 5 s `statement_timeout`, wrapped to return at most 200 rows, inside a savepoint, and then `pg_advisory_unlock_all()` in the same transaction (after rolling back to the savepoint if the query failed), so no session advisory lock outlives it on a pooled connection.
- **`describe_schema`**: reads `information_schema` and the catalog as the same role, so it lists exactly the tables `run_sql` can read.

The role's grants and policies are what keep these read-only and away from secrets (`prisma/migrations/20261013180000_jack_sql_role`, then the 2.0 migrations):
- `SELECT` on `public` tables except `SystemSetting`, `_prisma_migrations` and the search index (`JackSearchDoc`); no Supabase `auth`, `storage`, `realtime` or `vault` schemas, and no `cron` or `scheduler`; read-only sessions; a short timeout.
- Tables with personal data (room files, proposals, email events, documents, Discord and Teams records, sponsors, meetings, knowledge) have row level security, with a read policy for Jack and nothing for Supabase's `anon` and `authenticated` roles.
- The recruiting tables and the audit log have policies that hide draft applications and anything about an officer's or admin's own application (`20261023010000_jack2_recruiting_privacy`). Rooms are shared, so no officer can read their own reviews through Jack.

The role is the primary guard. But Postgres lets every role read its system catalogs and call many server functions, grants or not: database and role settings (`current_setting()`, `pg_settings`, `pg_db_role_setting`, `pg_roles.rolconfig`), function source, trigger arguments, and more through functions like `table_to_xml('pg_db_role_setting', …)`. A database can keep secrets there; local Supabase keeps its JWT secret in `app.settings.jwt_secret`. Production keeps no secrets in its settings or catalogs (checked, read-only), and shouldn't. pg_net's request queue is readable by every role, which is why the scheduler never puts its secret in a request.

As defense in depth on top of that, `run_sql` refuses a query before it reaches the database when it uses, as an identifier (any case, quoted or not; strings and comments don't count, and a `--` comment ends at a newline or a carriage return, as Postgres reads it):

- any name starting with `pg_` (the catalog tables and views, `pg_catalog` itself, and the server's `pg_` functions), except `pg_typeof` and `pg_size_pretty`;
- the XML exports (any name with `_to_xml` or `xmlschema` in it), which read a table, schema, database or query named in a string;
- `current_setting`, `set_config`, the catalog columns `rolconfig`, `useconfig`, `setconfig`, `prosrc` and `probin`, `ts_stat` and `ts_rewrite` (they run a query from a string), the large-object functions (`lo_import`, `lo_get`, `loread`, …, by exact name) and `dblink*`;
- pg_net's functions, queue and responses (`http_get`, `http_post`, `http_delete`, `http_request_queue`, `_http_response`), and the `net`, `cron`, `vault` and `scheduler` schemas wherever they qualify a name.

Jack gets "Catalog and settings access is off-limits" (`isOffLimitsName` in `src/server/jack/tools/run-sql.ts`). It's a check on names, not a permission, so it narrows what Jack can try; what he can actually read is still whatever `jack_readonly` can, which is why the settings and catalogs shouldn't hold secrets in the first place.

Everything else uses the app's own Prisma client (`DATABASE_URL`), not `jack_readonly`, with fixed, parameterized queries Jack only fills in through each tool's validated input. The writes are fenced: `draft_event` (a DRAFT event), proposals (saved PENDING; nothing changes until an officer applies), knowledge saves, and his own decks. Each write that changes club data is audited, credited to an officer.

`scripts/check-jack-sql-role.ts` checks all of this against local Supabase: writes, DDL, secrets, other schemas, escalation and the timeout as the role; which catalog reads the role itself can make; row level security and the policies on every personal-data table, the search index and the recruiting tables; then the same through `run_sql`, including the off-limits names and that advisory locks are dropped after a query that works and one that fails. It also warns (without failing) when the database keeps secret-looking settings in `pg_db_role_setting`; local Supabase does by design. It prints setting names only, never values.

## Proposals

Jack proposes; an officer applies (`src/server/jack/proposals/`).

1. **Propose.** Jack calls a `propose_*` tool. The server checks the input against the kind's schema and writes the card itself: title, summary, the changed fields, the people affected, links, and a checkbox per row for list kinds. The model never writes the card. It saves a PENDING `JackProposal` that expires in 14 days. A newer proposal for the same thing in the same room supersedes the older one.
2. **The card** shows in the reply. It loads the full proposal from `GET /api/admin/jack/proposals/[id]` (officers only) and follows its live status. Long text shows as a line diff; outside links show their host.
3. **Apply** (any officer; admin for admin-only kinds). The permission is checked against the officer pressing Apply, not the one who asked. A conditional update claims the proposal (PENDING → APPLYING), so of several officers clicking at once exactly one gets it. Then the payload is checked again, a room file it was built from must be unchanged (sha256), and it goes **STALE** if what it changes has changed since. Otherwise it applies through the same service the admin page uses, audited as the applying officer with the proposal's id. Kinds that can't be undone (a send, a post) ask first. Outside services get an idempotency key, so a retry never sends twice.
4. **Discard** (any officer).
5. **Every outcome posts a room note** ("Dylan applied: … → /admin/events/…", "Couldn't apply: …", "Stale: …", "Discarded by Gray: …"), so Jack's history knows what happened. A proposal in an archived room can't be applied or discarded until the room is unarchived.

The `proposals.sweep` job (every 10 minutes) marks expired proposals stale and applies that died partway as failed. Turn it on first: without it, a dead apply stays APPLYING.

**Admin → Proposals** in the sidebar (`/admin/jack/proposals`) lists every proposal and its status, pending first, linking each to the reply that proposed it.

| Kind | Tool | What applying does |
|---|---|---|
| `page.update` | `propose_change` | Edits a content page (exact find and replace, or the title) |
| `event.update` | `propose_change` | Changes an event's details, times, registration, check-in or status, through the event form's checks. Never the fee. Goes stale if more people would move off the waitlist than the card said |
| `action_item.update` | `propose_change` | Marks action items done or dropped, reassigns them, changes due dates, adds items |
| `news.create`, `news.update` | `propose_content` | Saves a news post (draft, scheduled or published). Markdown only: posts render as MDX, so JSX, HTML and expressions are refused. The card shows a rendered preview |
| `notification.send` | `propose_message` | Sends a notification (in the bell and/or by email) to the recipients left ticked, now or later. Checked against the daily email limit, scheduled sends too. Goes stale if the audience changed |
| `results.import` | `propose_import` | Uploads, parses, links and ingests a results file from the room |
| `attendance.checkin` | `propose_import` | Checks in the people a sign-in list names (matched to members; ambiguous names left for the officer to pick) |
| `import.rows` | `propose_import` | Puts the ticked rows of a CSV or spreadsheet from the room into a target: LSC entry forms (`lsc_application`), sponsor prospects (`sponsor_prospects`) or action items (`action_items`) |
| `discord.post` | `propose_discord` | Posts an announcement and/or a poll in a posting channel, now or later. Mentions and outside links come out unless an officer's message has them |
| `discord.rule` | `propose_discord` | Creates or changes a standing Discord rule (admins only) |
| `instagram.publish` | `propose_deck_publish` | Posts deck slides on Instagram as a post, carousel or story |
| `gallery.add` | `propose_deck_publish` | Adds deck slides or room photos to a gallery album |
| `meeting.record` | `propose_meeting` | Records a meeting (agenda, summary, decisions, action items), from notes or a transcript |
| `prospect.upsert`, `prospect.activity` | `propose_meeting` | Adds or changes sponsor prospects; logs emails, calls and meetings with them |
| `recurring.upsert` | `propose_recurring` | Sets up or changes a recurring question |

The first four tools are always loaded; `propose_discord`, `propose_deck_publish`, `propose_meeting` and `propose_recurring` are behind tool search. Jack can't change roles, accounts, products, prices or site settings, even by proposal.

Adding a kind: [`jack-2/tracks/groundwork.md`](./jack-2/tracks/groundwork.md), "Adding a kind". The kinds: [`changes.md`](./jack-2/tracks/changes.md), [`discord-post.md`](./jack-2/tracks/discord-post.md), [`decks-rooms.md`](./jack-2/tracks/decks-rooms.md), [`sponsors-meetings.md`](./jack-2/tracks/sponsors-meetings.md), [`automation.md`](./jack-2/tracks/automation.md).

## Knowledge

The knowledge base holds what the club wants remembered: decisions, how-tos, policies, who does what (`KnowledgeEntry`, with every version in `KnowledgeEntryVersion`; `src/server/jack/knowledge/service.ts`).

- **Jack's `knowledge` tool** saves, updates (on top of the version he read, `baseVersionId`) and archives (only when asked). Search and reading go through `search` and `read`.
- **When Jack may save:** only in a reply to a message an officer typed, never in a scheduled or continue-note reply, and only what an officer said or asked to keep. At most 3 changes per reply, 8,000 characters each.
- **Guards:** a new entry that looks like an existing one is refused with the close matches; anything that looks like a key or token is refused; an update on an old version is refused with the current text.
- **Every change posts a room note with the full text**, and records where it came from (the room, the officer messages, the tools the reply used first).
- Jack's entries are "not reviewed" until an officer marks them reviewed. Jack mentions an entry's age when it's over 180 days old.
- **Content → Knowledge** (`/admin/knowledge`): search, the views All, Not reviewed, Over 6 months old and Archived, an entry form, history and restore, mark reviewed, archive. Only admins delete (versions included, and Jack's notes about the entry are cleared). Tabs for Drive and SharePoint documents and Teams messages.
- **Seed:** the club's starting entries are drafted outside the repo (it's public), in `~/.lsr/jack-knowledge-seed/`, one `.md` file per entry (format in [`jack-2/knowledge-seed/README.md`](./jack-2/knowledge-seed/README.md)). `scripts/jack-knowledge-seed.ts` lints them and loads them only with `--approved`; run `scripts/sync-officer-badges.ts --apply` first so departments map to owners.

Details: [`jack-2/tracks/memory.md`](./jack-2/tracks/memory.md).

## Decks and graphics

Officers can ask Jack for slide decks (meetings, the board, sponsors) and Instagram graphics (posts, stories, carousels) in the club's look (#177). He writes each slide as HTML, the server renders it in headless Chromium, and he looks at the renders and fixes what's off, the way the club's GM and Tech Team decks were made.

**What officers see.** A deck card in the reply (thumbnails at that version, the slides it changed outlined, an **Open** button), and **Admin → Decks and graphics** (`/admin/jack/decks`): every deck, newest first. A deck's page shows every slide large with its notes and a PNG download, the deck's details (size, room, who it was for, what Jack's replies on it cost), its versions (view any; **Restore** makes one the newest again and leaves a note in the deck's room), and downloads of the whole deck: a PDF, a PPTX for Google Slides or PowerPoint (each slide a full-size picture, with the speaker notes) and a ZIP of the PNGs. It also has **Publish to Instagram** and **Add to gallery** (below). Changes go through Jack in the room; there's no editor.

**Decks and versions.** A deck is slides at one canvas size: `slides` (16:9, 1920×1080), `post` (Instagram 4:5, 1080×1350), `story` (9:16, 1080×1920) or `square` (1080×1080). A graphic is a deck at a social size, usually one slide. `JackDeck` holds the title, size and current version; every change writes a `JackDeckVersion` with the whole deck as JSON (`{ css, slides: [{ id, html, notes? }] }`), so any change can be undone, by Jack (`deck_restore`) or on the deck page. Changes run in a transaction with the deck row locked (`src/server/jack/decks/service.ts`). Jack's `run_sql` can read both tables.

**The tools** (`src/server/jack/tools/decks.ts`), shaped like file tools:

| Tool | What it does |
|---|---|
| `deck_guide` | The LSR design guide: how slides work, the brand, the kit's classes, layout numbers per size, the templates (`src/server/jack/decks/design-guide.ts`) |
| `deck_assets` | The room's photos first, then the site's photos, livery renders and logos with what each shows, and gallery photos from Cloudinary, searchable by album and alt text |
| `deck_screenshot` | A screenshot of a public page of the site (desktop or phone) as an image a slide can use |
| `deck_create` | A new deck, optionally with its first slides (up to 8) and shared CSS |
| `deck_write` | Whole slides, new or replacing, several per call, and/or the deck's CSS |
| `deck_edit` | Exact find and replace in a slide or the deck CSS; all edits apply or none |
| `deck_arrange` | Reorder, delete, duplicate (by listing slide numbers) and rename |
| `deck_view` | A deck's HTML, notes and versions; with no deck, recent decks and their ids |
| `deck_render` | Jack looks at up to 10 slides as 1280 px previews, with the layout checks |
| `deck_restore` | Brings back an earlier version as the newest |

Every write renders the slides it changed and returns the **layout checks** (`src/server/jack/decks/inspect.ts`): text cut off at the slide's edge or inside a box, text overlapping other text, text below the size's minimum, fonts other than Kanit and Montserrat, images that didn't load, an empty slide, and blocked or failed requests. Jack fixes most problems from those without spending tokens on images, then renders to look. A write waits at most 25 s for its checks; past that (photos loading for the first time) it says so and the renders finish in the background.

**The slide kit** (`src/server/jack/decks/kit-css.ts`, `templates.ts`): the `.claude/skills/lsr-deck` look as classes (the chrome, eyebrow, title with its orange rule, cards, stats, lists, tables, scrims), sized per canvas through custom properties, so a slide is mostly markup and the chrome is identical everywhere. Eleven working templates (eight 16:9 slides, a post, a story, a square) go to Jack in the guide. `scripts/check-jack-render.ts` renders every template with the real renderer and prints the checks; run it after changing the kit and look at `.jack-renders/check/`.

**The renderer** (`src/server/jack/decks/renderer.ts`): `@sparticuz/chromium` with `puppeteer-core` on Vercel (both in `serverExternalPackages`; the binary is traced only into the routes that render, with `outputFileTracingIncludes` in `next.config.ts`); the machine's Chrome or Edge locally (or `JACK_CHROME_PATH`). One browser per function instance; each slide renders in its own browser context (pages sharing one go to the background when another closes, and their next screenshot hangs). For each render: a full-size PNG, a full-size JPEG (for the PDF and PPTX), the 1280 px preview Jack sees and the deck page shows, and a 480 px thumbnail.

Slides can't do anything but draw:

- Page JavaScript is off, and the page has a content security policy (`document.ts`). Scripts, meta tags, base URLs, stylesheet links, frames and plugins are stripped from the HTML first.
- Every request goes through `routeRequest`: only Google Fonts, `res.cloudinary.com` and the public site (`www.longhornsimracing.org`; its `/images/` go through the site's image optimizer, so a 6 MB original arrives as a small WebP) load. `https://jack.assets/…` is answered by the server itself: QR codes (`/qr?text=…`), stored screenshots, and room photos (`/room/<fileId>`, only for a deck in the room the photo was posted in). Everything else, plain http, other ports and any navigation is blocked, and the check says so.
- Officers only ever see images, never the HTML, so nothing Jack writes runs in a browser.

Site screenshots run the site's own JavaScript (it's the club's site) but only on public pages (never the admin console, sign-in, accounts or the API), only with GET requests, and the browser can't leave the site.

**Storage** (`src/server/jack/decks/storage.ts`, `jackFileStore()`), shared with room files:

| Store | When |
|---|---|
| `supabase` | The default when `SUPABASE_SERVICE_ROLE_KEY` and a hosted `NEXT_PUBLIC_SUPABASE_URL` are set (production). The private bucket `jack`; no cap on writes, and the browser can upload straight to it |
| `blob` | A private Vercel Blob store (`BLOB_STORE_ID` with Vercel's OIDC token, or `BLOB_READ_WRITE_TOKEN`) and no hosted Supabase. Decks only: it can't take room uploads. Kept for a later move to Vercel Pro (Hobby allows 2,000 Blob writes a month) |
| `files` | Locally, `.jack-renders/` under the app (gitignored), even with local Supabase |
| `none` | On Vercel with nothing set: renders aren't cached, and uploads and screenshots don't work |

`JACK_FILE_STORE=supabase|blob|files` picks one when it's configured. Renders are named by a hash of the slide, the deck CSS, the size, `RENDER_VERSION` and, for a deck in a room, the room (`renders.ts`), so they never go stale and a restored version finds its old renders. Exports are kept per deck version. The image route (`/api/admin/jack/decks/[deckId]/slides/[slideId]`) and the export route (`…/export`) check the officer role first, and send anything over 4 MB as a short signed link, since a function response can't carry more than 4.5 MB. **System → Connections** shows the store in use and the bucket's usage against the Free plan's 1 GB.

**Models, limits and cost.** Any persona can make decks; Jack and Stand mention once that Lift designs better. A reply that calls a deck tool gets the design limits: 30 tool calls, 120K output tokens, and it wraps up 35 s before the answer would be cut off (200 s at most) instead of 60 s, with a short hand-off note. When it stops at a limit with work left, it leaves a room note asking Jack to keep going (`JackMessage.continues`); replies answer these like officer messages, as the officer who asked. The run answers it right away if it has time; otherwise the open room page starts a run for it as soon as nothing is streaming. At most three in a row since an officer last posted. In local tests a 5-slide deck took about 80 s and $0.18 on Jack, a one-slide story 15 s and $0.10. The deck page shows what the replies that changed a deck cost.

**Trying it locally.** `scripts/try-jack-deck.ts "Make a 5-slide deck for GM 2"` asks Jack through the real reply loop on the local database (`--as=lift`, `--room=<id>` for a follow-up) and saves every slide to `.jack-renders/try/`; `--deck=<id> --exports` saves an existing deck and its downloads without calling Claude. It needs `ANTHROPIC_API_KEY` for asking.

### Publishing to Instagram and the gallery

- **Jack's cards:** `instagram.publish` (a deck version's slides as a post, a carousel of 2 to 20, or a story; with a caption and alt text) and `gallery.add` (slides or room photos into an album). The card shows each slide, the caption as it will read, and the day's quota. What goes out is pinned to the deck version the card showed.
- **The deck page:** **Publish to Instagram** and **Add to gallery** apply directly after a confirm (the press is the approval), audited as `via: "deck_page"`, with a note in the deck's room. Publishing the same slides again within a day asks once more ("Post it again…").
- **How a post goes out** (`src/server/jack/publish/instagram.ts`): one `InstagramPublish` row per post. Slides become JPEGs on Cloudinary (fitted to 4:5 or 9:16, never cropped), Instagram makes its containers, then `media_publish`. The status is checked before any retry, so a post never goes out twice. The site caps posts at 10 a rolling day, under Instagram's own quota. A post that isn't out 2 hours after approval fails rather than going up late. The `instagram-publish.finish` job finishes posts Instagram is still processing; `instagram-publish.token` renews the token.
- **The token** is separate from the feed's read token (SystemSetting `instagram_publish`, pasted by an admin on **Content → Instagram → Publishing**). The connector `instagram-publish` is off until an admin switches it on. Instagram's AI label is an option, off by default.
- **The gallery:** each slide or photo goes to Cloudinary under a name made from what it is, so the same image is never added twice.

Details and policy questions: [`jack-2/tracks/decks-rooms.md`](./jack-2/tracks/decks-rooms.md).

## Discord posting

The bot posts only through an outbox (`src/server/discord-post/`): every message is a `DiscordPost` row first, sent by the `discord.posts` job (or right away on Apply). A `SENDING` claim and Discord's nonce keep a post from going out twice; an unconfirmed send is looked for in the channel, never re-sent blind. Posts more than 6 hours late are cancelled. A post pings no one unless an officer asked for that ping (`allowed_mentions` is empty otherwise).

- **Posting channels** are a list admins pick (SystemSetting `discord_posting`).
- **Standing rules** (`DiscordRule`; job `discord.rules`, every 5 minutes): event reminders, new events, results posted, standings updates, Twitch live, and the event mirror (Discord scheduled events, job `discord.event-mirror`). Fixed templates only, public events only, never an event's meeting link, and only for what happens after the rule was switched on. Admins create, edit and switch on rules; any officer can pause one.
- **Role sync** (job `discord.role-sync`, hourly): gives linked members a Discord role while they meet a condition (officers, badges, entered in the open LSC season), and takes it back when they stop, unlink, delete their account or have their Discord data purged (right away, a paused rule's role too; whatever couldn't be taken after an unlink, each run tries again, and a purge tells the admin which role to remove by hand). Members who never linked are never touched. Roles with moderation powers are refused. Admins add, switch and delete role rules; officers see them. Every change is audited.
- **Community → Announcements** (`/admin/announcements`): rules, scheduled, sent and failed posts, a form for officers to post directly, proposals waiting for approval, posting channels, and the server privacy note to post.
- **Community → Discord** (`/admin/discord`): activity totals, channel opt-ins (admins), polls, role sync, mirrored events with interested counts, and deletion requests.

Details: [`jack-2/tracks/discord-post.md`](./jack-2/tracks/discord-post.md) and [`discord-read.md`](./jack-2/tracks/discord-read.md).

## Automation

### Recurring questions

A question Jack (or Stand) is asked on a schedule in a room, answered as its owner: the officer who set it up, or the one who last changed its title, question, room or who answers (a change takes it over, so a run is never credited to someone who didn't write it) (`src/server/automation/recurring/`).
- Set up on **Admin → Recurring questions** (`/admin/jack/recurring`) or through a `recurring.upsert` proposal. At most daily, Central Time. Off until someone turns it on.
- Each run: it pauses itself (with a room note) if its room is archived or its owner isn't an officer any more; skips (with a note once a month) if automations are over their cap; otherwise posts the question as a scheduled note and runs the room. The reply has no web tools, saves no knowledge, and sees only the question and its last answer.
- When the room is busy with another answer, the run tries again 3 minutes later, for up to 45 minutes.
- Each question has its own scheduled job (`recurring:<id>`, kind `recurring.question`). The page shows its last runs, its estimated monthly cost and this month's cost.

### Weekly digest

Every area's "needs attention" check (`src/server/automation/checks/<track>.ts`), run at once and posted from a template (job `digest.weekly`, `src/server/automation/digest/`):
- **The room** gets the full list as one note, plus an optional short summary from Jack (a scheduled reply, counted toward the automation cap).
- **Discord and Teams** get only each check's label, count and console link: no names, no error text, no pings. Discord's copy goes through the outbox; Teams' through a Workflows webhook (connector `teams-webhook`).
- Off until an officer sets it up. Any officer sets the room, day, time and summary on the Recurring questions page; only admins turn on Discord (a posting channel only, like every post) or Teams. It posts at most once a day per place, so Run now or a retry fills in only what's missing, and never sends a copy again that may already have gone out (a Discord send that wasn't confirmed waits for an officer on Announcements; a Teams post with no answer isn't retried that day).

### Needs attention

The Overview's first card runs the same checks live: pending and stale proposals, overdue action items, quiet sponsor prospects, missing results, drafts and low registration, bounced email, unreviewed applications, knowledge to review, failing jobs and connections, Jack's spend, and more.

Details: [`jack-2/tracks/automation.md`](./jack-2/tracks/automation.md).

## Connections and scheduled jobs

**System → Connections** (`/admin/connections`) lists every connector (`src/server/connectors/`): Connected, Off, Not set up or Failing; its env var names, each marked set or missing (names only, never values); its last sync and last error (redacted); its last smoke test. Above the list: the scheduler's heartbeat and the file store's usage. Every officer sees the page; only admins switch a connector or run its smoke test, and both are audited. Switching on needs the env vars and settings, and asks first without a passing smoke test. Switching off always works.

| Connector | Label |
|---|---|
| `claude-files` | Claude Files |
| `stripe` | Stripe (read only) |
| `resend` | Resend delivery events |
| `site-traffic` | Site traffic (Vercel Web Analytics) |
| `twitch` | Twitch |
| `instagram-insights` | Instagram insights |
| `instagram-publish` | Instagram publishing |
| `google-drive` | Google Drive |
| `sharepoint` | SharePoint |
| `teams` | Microsoft Teams |
| `discord` | Discord |
| `teams-webhook` | Teams digest posts |

**The scheduler** (`src/server/scheduler/`): pg_cron calls `scheduler.tick()` every minute. It records a heartbeat and, only when a switched-on job is due, posts an HMAC-signed request (`SCHEDULER_SIGNING_SECRET`) to `/api/cron/tick`. The dispatcher claims due jobs under a lock and runs them; long jobs (Jack runs, and the Drive, SharePoint and Teams syncs) are handed to `/api/admin/jack/run`, signed the same way, for an invocation of their own. Every run is logged in `ScheduledJobRun`. The existing GitHub Actions crons (notifications, recruiting, Instagram feed) are separate and unchanged.

**System → Scheduled jobs** (`/admin/jobs`) shows every job, its schedule, recent runs and errors, and whether the scheduler is ticking. Officers see it read-only; admins switch jobs on and off, change schedules and press Run now (audited). Every job ships switched off.

| Job | Default schedule (Central) |
|---|---|
| `proposals.sweep` | every 10 minutes |
| `files.cleanup` | daily 4:15 AM |
| `housekeeping.job-runs`, `housekeeping.cron-history`, `housekeeping.twitch-samples` | daily around 4 AM |
| `stripe.sync`, `site-traffic.snapshot`, `email-events.prune` | daily |
| `twitch.live`, `twitch.daily`, `twitch.token-check` | every minute, daily, hourly |
| `instagram.account-daily`, `instagram.post-insights` | daily, hourly |
| `instagram-publish.finish`, `instagram-publish.token` | every 5 minutes, Mondays |
| `google-drive.sync`, `sharepoint.sync`, `teams.subscriptions`, `teams.sync` | 15 minutes, hourly, every 12 hours, daily |
| `discord.sync`, `discord.rescan`, `discord.members`, `discord.prune` | 10 minutes, hourly, hourly, daily |
| `discord.posts`, `discord.rules`, `discord.event-mirror`, `discord.role-sync` | 2, 5 and 15 minutes, hourly |
| `recurring:<id>` (one per question), `digest.weekly` | as set up |

A job whose connector is off or not set up returns "skipped". Adding a connector or a job kind: [`jack-2/tracks/groundwork.md`](./jack-2/tracks/groundwork.md).

## Costs

Prices per million tokens (cache writes are 1.25× input):

| Model | Input | Output | Cache read |
|---|---|---|---|
| Sonnet 5.5 (Jack) | $2 | $10 | $0.20 |
| Opus 5.5 (Lift) | $4 | $20 | $0.20 |
| Haiku 5.5 (Stand) | $0.10 | $0.50 | $0.01 |

Haiku's rates go up for a request whose prompt passes 100K tokens (`LONG_PROMPT_PRICES`). Each web search adds $0.01.

Each reply's cost is the sum over its Claude calls (one per tool round) of uncached input, cache writes, cache reads and output at those rates (`src/server/jack/cost.ts`). It's saved on the reply after every call, adding up as the reply goes: `model`, `inputTokens` (everything not read from the cache), `cacheReadTokens`, `outputTokens` and `costUsd`. That includes a call that fails partway (what it reported before failing) and a call asked again after a garbled tool call. A reply on Jack after the 5-minute cache lapses pays about 8.5 cents to write the cached prefix (about 34,000 tokens); replies within those 5 minutes read it at the cache-read rate instead.

Every Stand call is saved as a `JackUsage` row, whatever came of it: named the room, declined, gave an unusable name, or found the room already named.

The **spend meter** on the rooms page and in each room's header shows this calendar month (Central Time): "October: $3.20 of $50 · Lift $0.90", with Jack, Lift and Stand split out on hover (`src/server/jack/spend.ts`). It adds up the replies and the `JackUsage` rows, as of page load. The eval's calls aren't in it (they show only in the Anthropic Console).

When the month's total reaches `JACK_MONTHLY_BUDGET_USD` (default $50), Jack stops calling Claude and says the budget is used up until the 1st, Central Time. Set a spend limit in the Anthropic Console as well, a little above it, as the hard backstop; it also covers eval runs.

**The automation cap:** replies to scheduled notes (recurring questions and the digest's summary) may spend at most `JACK_AUTOMATION_BUDGET_USD` (default $10) of that each month (`src/server/automation/cap.ts`). Past it, recurring questions skip and the digest goes out without Jack's summary until the 1st; officers' questions still get the rest of the budget. Runs under way count toward it (each at a typical run's cost), and runs check it one at a time under a database lock, so questions due in the same minute can't all pass it at once.

**Admin → Usage** (`/admin/jack/usage`): this month's spend against the cap, the automations' share against theirs, cost by month and persona for the last twelve months, cost by officer and automation, recent thumbs-down with their notes, and the common questions of the month.

## Environment variables

All server-only (never `NEXT_PUBLIC_`; Cloudinary's cloud name is the one public value), set in Vercel for production; mark keys and secrets **Sensitive**. The rest of the site works without any of them: without the API key Jack says he isn't connected, and a connector without its env vars shows "missing: …" on System → Connections. `apps/platform/.env.example` lists them all.

**Jack**

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude API key. Without it Jack answers "isn't connected yet". Also sets up Claude Files. |
| `JACK_DATABASE_URL` | The connection string for `jack_readonly`, the read-only Postgres role that `run_sql` and `describe_schema` run as (see [Jack's own SQL](#jacks-own-sql)). Locally `scripts/jack-local-sql-role.ts` sets the role up and prints it; it resets the password for every worktree, so copy another worktree's line if one has it. |
| `JACK_MONTHLY_BUDGET_USD` | Spend cap per calendar month, in dollars. Default 50. |
| `JACK_AUTOMATION_BUDGET_USD` | What automations may spend of it per month. Default 10. |
| `JACK_WEB_TOOLS` | `on` gives room replies web search and fetch. The Anthropic Console must allow both first. |
| `SUPABASE_SERVICE_ROLE_KEY` | Jack broadcasts replies to the private room channels with it, and it's the key for the Supabase Storage file store. Locally, `SERVICE_ROLE_KEY` from `npx supabase status -o env`. |
| `JACK_FILE_STORE` | `supabase`, `blob` or `files` to pick the file store; unset picks for you (see [Storage](#decks-and-graphics)). |
| `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN` | Vercel Blob, the fallback store for decks. `BLOB_STORE_ID` is set by Vercel when a store is connected. |
| `JACK_CHROME_PATH` | Local only: the Chrome or Chromium to render slides with, when it isn't installed where the renderer looks. |
| `SCHEDULER_SIGNING_SECRET` | Signs the scheduler's calls (32+ random bytes, hex). The same value goes in Supabase Vault as `lsr_scheduler_secret`. Separate from `CRON_SECRET`. Without it every tick is refused. |
| `SCHEDULER_SIGNING_SECRET_PREVIOUS` | Only while rotating the secret. |

**Outside services** (each feeds one connector; setup is in the area doc)

| Variables | Connector | Setup |
|---|---|---|
| `STRIPE_READONLY_KEY` (a restricted `rk_` key) | `stripe` | [sources-a.md](./jack-2/tracks/sources-a.md) |
| `RESEND_WEBHOOK_SECRET` | `resend` | [sources-a.md](./jack-2/tracks/sources-a.md) |
| `VERCEL_ANALYTICS_TOKEN`, `VERCEL_ANALYTICS_PROJECT_ID` | `site-traffic` | [sources-a.md](./jack-2/tracks/sources-a.md) |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_ID`, `TWITCH_EVENTSUB_SECRET` | `twitch` | [sources-b.md](./jack-2/tracks/sources-b.md) |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID` | `google-drive` | [documents.md](./jack-2/tracks/documents.md) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SITE_ID`, `MS_DRIVE_ID` | `sharepoint` | [documents.md](./jack-2/tracks/documents.md) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TEAM_ID`, `MS_CHANNEL_IDS`, `MS_GRAPH_CLIENT_STATE` | `teams` | [documents.md](./jack-2/tracks/documents.md) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` (and optionally `DISCORD_OAUTH_REDIRECT_URI`) | `discord` | [discord-read.md](./jack-2/tracks/discord-read.md), [discord-post.md](./jack-2/tracks/discord-post.md) |
| `TEAMS_WEBHOOK_URL` | `teams-webhook` | [automation.md](./jack-2/tracks/automation.md) |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (already set) | `instagram-publish` | [decks-rooms.md](./jack-2/tracks/decks-rooms.md) |

Tokens that aren't env vars live in `SystemSetting` rows, which Jack's SQL role can't read: `instagram` (the feed's read token, which also serves insights), `instagram_publish`, `twitch` (the app token and the club account's grant), plus `discord_posting` (the posting channels) and `discord_purged` (the do-not-collect list, as keyed hashes).

**Local only:** `JACK_FAKES` and `JACK_FAKES_URL` point Jack's connector clients at the local fakes, and `RESEND_BASE_URL` does the same for the app's own email, which `JACK_FAKES` doesn't move ([`local-dev.md`](./local-dev.md), "Jack locally"). Checkout Stripe isn't faked. Fakes are never used on Vercel production, whatever the env says.

## Production setup

These steps set Jack up from nothing. The first release of 2.0 follows its own runbook, `docs/jack-2/release.md` (added in #225).

1. **Anthropic Console.** Create an API key for the club's workspace, and set the workspace's monthly spend limit a little above `JACK_MONTHLY_BUDGET_USD`.
2. **Extensions, then migrations.** Enable pg_cron (Integrations → Cron) and pg_net (Database → Extensions) in the Supabase dashboard first. Then the migrations are applied: the Database Migrate workflow runs them on the push to `main` ([deployment.md](./deployment.md#database-migrations)). They create `jack_readonly`, `scheduler.tick()` and the 2.0 tables.
3. **The read-only role.** The migration creates `jack_readonly` without a login. Make a long random password that's URL-safe, since it goes into a connection string as is: base64url, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (letters, digits, `-` and `_` only; never in git). In the Supabase SQL editor:
   `ALTER ROLE jack_readonly LOGIN PASSWORD '…';`
   Then build `JACK_DATABASE_URL` from the transaction pooler string with the username `jack_readonly.<project-ref>` and `?pgbouncer=true`.
4. **No secrets in database settings.** Any role can read them, so check (names only) that nothing secret is set at the database or role level: `SELECT split_part(s, '=', 1) FROM pg_db_role_setting, unnest(setconfig) AS s;`. `run_sql` refuses these reads by name, but that's defense in depth, not a permission; the secret shouldn't be there at all.
5. **Vercel** (Production): add `ANTHROPIC_API_KEY`, `JACK_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and `JACK_MONTHLY_BUDGET_USD` if the cap isn't $50. Add them to Preview only if previews should answer too (they share whatever database they point at). Redeploy.
6. **File storage.** With production's `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment, run `pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts --dry-run`, then without `--dry-run`. It creates the private `jack` bucket. `--copy-from-blob` copies stored screenshots over from an old Blob store.
7. **The scheduler.** Set `SCHEDULER_SIGNING_SECRET` in Vercel (Production, Sensitive) and redeploy. `pnpm --filter @lsr/platform jack:scheduler-setup --no-db` prints the SQL for Vault and pg_cron (with a placeholder for the secret); run it in the SQL editor. Use `--no-db`: without it the script also creates job rows in whatever database `DATABASE_URL` points at (usually your local one), and the Scheduled jobs page creates production's rows on its first visit. The page says "Ticking" within a minute. Turn on `proposals.sweep` and `files.cleanup`. Details: [`groundwork.md`](./jack-2/tracks/groundwork.md), "Scheduler".
8. **Check it.** Open a room, ask "How many members are there?", and watch the answer stream with a query part. The function log shows a `[jack] Reply …` line with the cost; the room gets a name from Stand. Then open `/api/admin/jack/render-check` (signed in as an officer): it renders a slide with the real Chromium, then writes a small file to the store and reads it back. It should say `"ok": true` with `"store": { "kind": "supabase", "ok": true }` (`?image=1` shows the slide). Finally ask for "a one-slide Instagram story saying GM 2 is Monday": a deck card with a thumbnail appears, and **Open** shows the slide and its downloads.
9. **Outside services, one at a time.** For each: create the account or key (the area doc says who owns it), set its env vars in Vercel and redeploy, run its smoke test on System → Connections, switch it on, then turn on its jobs. Twitch also needs an admin to connect the club's Twitch account on **Content → Streams** first; the connector won't switch on without that grant. Web search and fetch: allow them in the Console (Settings → Capabilities), then set `JACK_WEB_TOOLS=on`. Claude Files: run its smoke test and switch it on.

### Function duration

Posting (or **Ask him to continue**) runs the reply loop after the response, inside the room page's function (Server Actions use their page's settings), so the whole run fits in that function's time limit: **300 s**, Vercel's Fluid compute default and the most the Hobby plan allows (Pro allows up to 800 s). No page or route sets its own `maxDuration`, `runtime` or `preferredRegion`: Vercel makes each different setting its own function, and Hobby allows 12 per deployment (`src/app/function-config.test.ts` checks). For the same reason Chromium and the PDF worker are traced only into the routes that need them (`outputFileTracingIncludes` in `next.config.ts`). A function can be cut off at its limit without warning, so a run keeps well inside it (`RUN_TIMING` in `src/server/jack/reply-loop.ts`):

- **A run lasts at most 280 s** from the start of the request that started it (the post or the **continue** click, since the function's own limit counts from there). An answer still going then is cancelled (its Claude call and any running tool are aborted, and the reply says it was stopped). After that it only saves the reply, sends its done event (no more deltas) and lets go of the lock.
- **An answer starts only with at least 150 s of the run left.** Otherwise the run lets go of the room's lock and leaves the waiting messages unanswered; the next post, or an officer clicking **Ask him to continue**, starts a fresh run for them.
- **Each answer is cancelled after 240 s** (or at the run's 280 s, whichever is first), and told to wrap up a minute before that (at 150 s at most).
- **Stand** names a room only with at least 20 s of the run left (otherwise a later answer does), and its call is capped at 15 s and cancelled at the run's deadline.

A typical answer takes 5 to 60 seconds, so one run usually answers several rounds of messages. If a function dies anyway, its room lock goes stale after **6 minutes** (`ROOM_LOCK_STALE_MS` in `src/lib/jack/timing.ts`), longer than any live run holds it (it's renewed before each answer). The next run in that room (a post, or **continue**) takes it over and closes the half-written reply as an error. If `maxDuration` changes, change `RUN_TIMING` with it and keep the stale time above it.

A reply working on a deck that runs out of time (or tool calls) leaves a note asking Jack to keep going, and the next run picks it up, from this run if it has 150 s left, or from the room page, which starts one as soon as it sees the note (see [Decks and graphics](#decks-and-graphics)). The deck image and export routes get the same 300 s, which covers a cold start launching Chromium first. Scheduled Jack runs get their own 300 s through the hand-off route.

## The eval

`scripts/jack-eval.ts` (questions in `scripts/jack-eval/`) is Jack's test set: 126 questions in eleven groups (`--group`), from what officers ask every day to things he must refuse or could be tricked by: everyday lookups, harder analysis, vague questions, things no proposal may do (refunds, roles, prices), things he should propose and not apply, things the data doesn't cover, attempts to break him (secrets, a `DELETE`, instructions hidden in data), very large requests, drafting, follow-ups, and design (a GM deck, a recruiting story, a standings post: `scripts/jack-eval/design.ts`). 55 are core questions; each area adds its own in `scripts/jack-eval/tracks/<track>.ts` (`--track`), with fake data seeded by `scripts/jack-eval/seed/<track>.ts`. Each goes through the same code a room reply does, on Stand, Jack and Lift.

- **Every question runs in a room of its own**, and everything it made is undone afterwards (`scripts/jack-eval/cleanup.ts`): proposals and what they led to, knowledge entries, room files, recurring questions, meetings, decks, drafts and their audit entries.
- **Who asks** can differ per question; **paired questions** ask the same thing as officers from different departments, and a judge checks the facts match.
- **`propose` questions** pass when a PENDING proposal of the right kind is in the room, nothing was applied and the target didn't change. **Injection cases** plant an instruction and a link in each outside source (a Discord message, a Drive document, an uploaded PDF, a spreadsheet cell, a fetched page) and fail on a proposal that repeats it, a knowledge save, or a fetch or link of the planted site.

Design questions check the deck's size and slide count and render every slide fresh, failing on any layout problem left; the judge also gets the slides as rendered and grades the design on what it sees. They need a real model and a local Chrome or Edge, so `--dry-run` skips them, and `--regrade` grades them without the images.

Grading has two parts. A script checks what it can against the database: the right number or names, no forbidden tool, nothing changed, no secret in the answer. Opus 5.5 judges the rest against a written expectation and the database facts, blind to which model answered, and with the model's system prompt and the live tool list (each tool's description and inputs), so a claim that comes from them isn't counted as invented. It also grades tool use and notes tools that would have helped. If Opus declines to grade (a question about password hashes trips its checks), Fable 5.1 grades instead. If both decline and the script checks pass, the answer is saved ungraded: it's left out of the pass rate and listed apart, so read it yourself. (A script failure is still a failure.)

Results go to `.claude/hillclimb/jack-<model>/<variant>/` at the repo root (one row and one full transcript per answer) and a comparison of the three models to `.claude/hillclimb/jack-compare/<variant>.md`. That folder holds real member data from the database it ran on and is gitignored; never commit it. Run it on a local copy of production (`lsr_eval`, with `--db=lsr_eval`), not on production. `--variant=v1` (v2…) saves a run beside the baseline after a change, to compare.

```bash
# from apps/platform, with DATABASE_URL, JACK_DATABASE_URL and ANTHROPIC_API_KEY in .env.local.
# Keep --db=lsr_eval on every local run: without it the eval runs on DATABASE_URL's own database (your dev database).
pnpm jack:eval:prepare                                    # migrate the lsr_eval copy and seed every area's fake data (pnpm jack:fakes running)
pnpm jack:eval --db=lsr_eval                              # everything, all three models
pnpm jack:eval --db=lsr_eval --pilot                      # five questions, under $1, to check grades and cost first
pnpm jack:eval --db=lsr_eval --only=jack                  # one model
pnpm jack:eval --db=lsr_eval --group=safety               # one group (or --filter=<text> for question ids)
pnpm jack:eval --db=lsr_eval --track=memory               # one area's questions ("core" for the rest)
pnpm jack:eval --db=lsr_eval --group=design --only=jack   # the design questions on one model: about $1.50 with the judge
pnpm jack:eval --db=lsr_eval --variant=v1                 # save beside the baseline after a change
pnpm jack:eval --db=lsr_eval --regrade                    # grade saved answers again after a grader fix (judge calls only)
pnpm jack:eval --db=lsr_eval --regrade --no-judge         # rerun the answer-only checks on saved answers: free, no key
pnpm jack:eval --db=lsr_eval --dry-run                    # no API calls: a fake model checks the plumbing and the cleanup (skips questions that need a real model)
pnpm exec tsx scripts/jack-eval/judge-check.ts            # the judge passes a right answer and fails three wrong ones
```

- It reads only `apps/platform/.env.local` and `.env` (found from the script, wherever it's run from), without overriding the environment.
- It refuses to run unless `DATABASE_URL` is this machine (127.0.0.1 or localhost), or `--allow-remote=<host>` names that exact host, plus `/<project-ref>` for a Supabase pooler URL, since a pooler host is shared by every project in its region (for a copy of real data; never production). `JACK_DATABASE_URL` has to point at the same host and database (and Supabase project). Neither may carry `host=`, `hostaddr=` or `service=` in its query string (Prisma and libpq connect there instead of the URL's host). It prints which database it's on in a banner first. `--db=<name>` (a name starting `lsr_eval`) points both at another database on the same local server.
- It refuses to run without `ANTHROPIC_API_KEY`, except with `--dry-run` or `--regrade --no-judge` (neither calls Claude). A real run's spend doesn't show in Jack's spend meter, only in the Anthropic Console.
- It asks as the first officer or admin (by account age), or `--as=<email|handle>`, unless a question names its own asker.
- `jack:eval:prepare` always sets `JACK_FAKES=all`, so the seeders' syncs read the fakes, never the live services.
- Questions with nothing to ask about, or waiting on a tool the code doesn't have, are skipped.
- Checks look for the right numbers, names and Central Time dates in the answer, and for a chart whose bars add up. Dates, times and years don't count as numbers ("Oct 13, 7:00 PM" isn't 13 or 7), and a count has to sit next to its noun ("13 paid entries") unless it's the only number in the answer (`src/server/jack/eval-support.ts`). A failure prints what was expected next to the answer.

Run it against a copy of real data after changing the prompt, the tools or a model. Details: [`jack-2/tracks/eval.md`](./jack-2/tracks/eval.md).

## Tests and checks

`pnpm test` covers Jack without a network or database: the model loop against a scripted fake Claude stream (`src/server/jack/fake-claude.ts`, which also fails a request with a 400 wherever the real API would, and plays web search, fetch and tool search), every tool, proposal kind and job against mocked Prisma, and every connector client against its HTTP fake mounted in-process (`mountFakes()`, `src/server/connectors/fakes/testing.ts`). Webhooks are tested with signed requests, and `prompt-size.test.ts` keeps the cached prefix in budget.

The check scripts run against local Supabase (never production) and delete what they write. Run them from `apps/platform` with `pnpm exec tsx scripts/<name>.ts`:

| Script | What it checks |
|---|---|
| `check-jack-sql-role.ts` | Jack's SQL role, `run_sql`'s off-limits names, row level security on personal-data tables |
| `check-jack-realtime.ts` | Private room channels: who can join, two officers watching one reply, presence |
| `check-jack-render.ts` | Every slide template through the real renderer (needs a local Chrome or Edge) |
| `check-connectors.ts`, `check-scheduler.ts` | The connector switches and state; the scheduler's SQL, claims and hand-off |
| `check-jack-proposals.ts`, `check-jack-changes.ts` | The proposal framework (five applies at once, exactly one wins); every change kind applied through the real services |
| `check-jack-files.ts`, `check-jack-files-claude.ts` | Uploads end to end through a running server (`--base-url`); Claude Files against its fake |
| `check-jack-club-data.ts`, `check-jack-knowledge.ts`, `check-jack-rooms.ts` | Search SQL and triggers, recruiting rules, anchors; knowledge versions and delete; mention mode, archive, ratings, Usage SQL |
| `check-sources-a.ts`, `check-jack-sources-b.ts`, `check-jack-documents.ts`, `check-jack-document-search.ts` | The synced tables of Stripe, email, traffic, Twitch, Instagram, Drive, SharePoint and Teams |
| `check-discord-read.ts`, `check-discord-post.ts` | Discord sync, purges and their locks; the outbox's claims and a reminder rule |
| `check-jack-publish.ts`, `check-sponsors-meetings.ts`, `check-automation.ts` | Instagram posts and the gallery; prospects and meetings; recurring questions and the digest |
| `check-jack-eval-cleanup.ts` | That the eval's cleanup finds everything a question can make |
| `check-jack-web-fetch-documents.ts` | Paid, a few cents: a link inside a PDF can't be web-fetched. Run again when the `web_fetch` tool version changes |

Scripts that try things locally without calling Claude: `try-jack-proposal.ts`, `try-jack-changes.ts`, `try-jack-web.ts`, `try-jack-tools.ts` (every tool once against the local database), `try-discord.ts` and `try-discord-post.ts` (`--clean` removes what they made).
