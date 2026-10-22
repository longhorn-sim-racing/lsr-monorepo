# Jack

Jack is the officer chat agent in the admin console (**Admin → Jack**, #161). Officers ask about club data (members, events and attendance, LSC entries, payments, standings, the audit log) and get plain answers, query results and charts back. Jack can also draft an event for an officer to review, and make slide decks and Instagram graphics in the club's look (see [Decks and graphics](#decks-and-graphics)). He only reads club data, except for those drafts, and he never moves money.

Code paths below are relative to `apps/platform/`.

## Rooms

- A room is a shared chat. Every officer sees every room and can post in it; there are no private rooms.
- Each message stores its author: an officer, a model (Jack, Lift or Stand), or the room itself (notes like "Gray switched this room to Lift").
- Jack answers on the server, so closing the tab doesn't stop an answer. One answer runs per room at a time (a run lock on the room); messages posted while he's answering wait, and the next answer covers all of them together.
- Text streams to everyone in the room over a private Supabase Realtime channel. Someone who opens a room mid-answer sees what's been written so far and then follows along. Tool calls show up in the reply where they happened: a part per call, "running" while it works, then its result (a query and its rows, a chart, an event draft) or an error.
- Only officers can join the channels; a database policy enforces it.
- The page catches up from the database when it might have missed something: on every (re)join, about 1.5 s after each finished reply, 30 s into a quiet spell while a reply is streaming (then less and less often, up to every 5 minutes, and not at all while the room offers to continue), and when a finished reply was too big to send whole over Realtime (see below). A fetch that fails is tried again, waiting longer each time. If the server closes the channel, the page says "Not connected" and joins again.
- When officer messages sit unanswered (no reply has picked them up; each message carries `answered`, and a reply's `message.created` lists the messages it answers) with nothing streaming for about 20 s (a run ran out of time, see [Function duration](#function-duration)), or a reply has been "answering" with no news for over 6 minutes (the run writing it died), the room shows "Jack stopped before answering" (or "partway through an answer") with an **Ask him to continue** button. It starts a run like posting does (`resumeJackRoom`, officers only). If a run still holds the room it says so instead; a dead run's lock is taken over once it's stale, which closes its half-written reply as an error and then answers what's waiting.

## Personas

| Name | Model | Effort | Used for |
|---|---|---|---|
| Jack | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | medium | Every answer, by default |
| Lift | Claude Opus 5.5 (`claude-opus-5-5`) | high | Long, multi-step analysis. Set per room with **Answered by** ("Lift (slower, higher cost)"); it stays until someone switches back, and the switch is posted in the room. About twice Jack's price per token; in the October eval it was no more accurate than Jack, about twice as slow and three times the cost per answer |
| Stand | Claude Haiku 5.5 (`claude-haiku-5-5`) | medium (low for side jobs) | Quick, simple questions, set per room with **Answered by** ("Stand (simple tasks)"), at about a twentieth of Jack's price per token. Also the side job of naming a new room after its first answer (`STAND_SIDE_JOB`) |

The names are the joke; the answers stay plain. Models and effort live in `src/server/jack/models.ts`. These models always think before answering (adaptive thinking can't be turned off); effort is the dial for how much.

## Renaming rooms

Any officer can rename a room at any time with the pencil next to its name (`renameJackRoom` in `src/app/admin/jack/actions.ts`, `renameRoom` in `src/server/jack/rooms.ts`). The room gets a note ("Alex renamed this room “GM 1 planning”"), everyone in it sees the new name live, and the change is in the audit log. Stand only names rooms that are still untitled, so it never overwrites a name an officer gave.

If a deploy has to be rolled back to a version from before Stand could answer rooms, first move those rooms back to Jack, or the older code fails reading them: `UPDATE "JackRoom" SET persona = 'jack' WHERE persona = 'stand';`

## How a reply works

1. An officer posts. The message is saved, shown to the room, and `runRoom()` starts after the response (`src/server/jack/reply-loop.ts`).
2. If `ANTHROPIC_API_KEY` isn't set, the reply says so ("Jack isn't connected yet…"). If this month's spend has reached `JACK_MONTHLY_BUDGET_USD`, the reply says the budget is used up. Neither calls Claude.
3. Otherwise the request is built (`src/server/jack/model-loop.ts`), in this order:
   - **tools**, in the fixed order of `JACK_TOOLS` (`src/server/jack/tools/index.ts`);
   - the **system prompt** (`src/server/jack/prompt.ts`): who Jack is, who he's talking to, the club, and the rules (read-only except drafts, never move money, name the admin page that does a change, say where numbers came from, Central Time, emails and EIDs only when asked, concise plain text, typed tools first, `run_sql` for the rest, `describe_schema` when unsure, charts through the chart tool), then the notes on the club's tables (`JACK_SCHEMA_NOTES` in `src/server/jack/tools/schema-notes.ts`);
   - the **room history** (`src/server/jack/history.ts`): each exchange as an officer turn ("Name: message" lines under a Central Time timestamp, room notes included) and the reply's text with a one-line note of the tools it used. Several officers' messages answered together are one turn, and notices that never reached Claude ("isn't connected yet") are left out so their questions carry over. The last 40 exchanges are sent.
4. Claude streams. Text goes out in ~150 ms batches. Each tool call is checked against the tool's schema, run for the officer whose message started this reply (the newest message it answers; when one reply answers several officers, it's the last one who posted), saved on the reply (`JackMessage.toolCalls`) and broadcast (`message.tool`), and its result goes back to Claude. This repeats until Claude answers.
5. Limits per reply: 12 tool calls, then Claude is told to answer with what it has (and can't call more tools); the same after 64K output tokens, or after 150 s (sooner when the run has less time left; see [Function duration](#function-duration)); 32K output tokens per call for Jack and Lift (a deck write holds several slides), 16K for Stand. A reply working on a deck gets more (see [Decks and graphics](#decks-and-graphics)).
6. After every Claude call the reply's tokens and cost so far are saved on it, so a reply that's cut off, or whose function dies, still counts. The finished reply is saved with its model, tokens and cost, and its cost is logged (`[jack] Reply … $0.0123, … in + … cache write + … cache read, … out`).
7. The `message.done` event carries the whole reply. If it's over about 200 KB (Realtime drops messages over its limit, about 256 KB on the Free plan) it goes out `trimmed`, without its tool displays (or its text, if that's still too big), and the page loads the full reply from the database.
8. If the room has no title yet, Stand names it in 2 to 5 words in the background and posts "Stand named this room “…”".

What the room sees when something goes wrong:

| What happened | The reply |
|---|---|
| Claude's safety checks declined | "I can't help with that one…" (status done). A partial answer before the decline is taken back, for viewers too: a delta marked `replace` swaps the text so far for the new text |
| A streamed tool call came through garbled | The call is asked again (twice at most). Its text is taken back the same way, so it isn't shown twice, and its tool part shows "Didn't run" |
| An answer cut off at the length limit | The text so far plus a note. A tool call that was cut off isn't run |
| The API failed (rate limit, overload, bad key, network) | The text so far plus a plain explanation, status **error** |
| The answer ran out of time | "This answer was stopped before it finished", status **error** (see [Function duration](#function-duration)) |
| A tool failed | The part shows the error; Claude sees it and usually works around it |
| Saving a partial reply mid-stream failed | Nothing: it's logged and the stream goes on; the final save writes the whole text |

### Refusals

Sonnet 5.5 and Opus 5.5 run safety classifiers that can decline a request (cyber, bio and a few other categories), occasionally on harmless club questions. Replies opt into Anthropic's server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a declined request is retried on the model Anthropic recommends for that category, inside the same call. The fallback attempt is billed at that model's rates, and the cost math prices each attempt by the model that ran it. Not every category is retried (from Sonnet 5.5, only cyber and frontier_llm declines are); then, or when the fallback model declines too, the room sees the refusal message. Haiku has no server-side fallback: a declined room answer from Stand shows the refusal message, which suggests switching the room to Jack, and a declined room name just leaves the room untitled.

### Prompt caching

Every request starts with the same tools and system prompt, with a cache breakpoint at the end of the system prompt, and automatic caching on the conversation after it. Cache reads cost a tenth of normal input (less on Opus), so a room's follow-ups mostly pay for what's new. This stays cacheable because:

- the system prompt has no dates, names or counts in it (the time is in each officer turn instead), and the tools never change order;
- the history is rebuilt from the saved messages the same way every time, so each request's history is the previous one plus the new exchange. The 40-exchange window moves its start in steps of 10, so it stays put for several turns;
- within one reply, each Claude turn goes back exactly as it came (thinking included), with its tool results appended after it.

Thinking blocks are only ever sent back within the reply that made them. Earlier replies go back as text, so no thinking block is replayed into an edited conversation (which these models reject). Requests set `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`), so if a bug ever did edit the history, the reply would continue without that thinking instead of failing; it's logged as a warning.

## Tools and the database

The typed tools carry the club's definitions, so Jack should rarely need his own SQL. After the October eval (see [The eval](#the-eval)) they cover what officers asked for most:

- `club_members` lists a **roster**: the officers with titles, emails and EIDs, or every member (optionally by join date) with email, EID, join date, roles, events registered for, check-ins, races driven, this LSC season's entry status and money paid.
- `member_activity` ranks members by registrations, check-ins and races driven.
- `lsc_entries` gives each driver's school (the form leaves it blank for UT Austin), experience, equipment and form notes, and counts forms by school and experience.
- `events_overview` says whether an event takes registrations and check-ins at all (settings, not whether they're open now), how full it was, and can list only events that had check-ins.
- `payments_summary` lists the people who started a checkout and never paid for that item (`unpaidCheckouts`), the club's definition.
- `draft_event` returns the whole link, so the reply never guesses the site's address.

**Times.** Every tool gives times in Central time with the weekday ("Fri 2026-10-09 16:49 CT", `ct()` in `tools/time.ts`), so no model works a weekday out. Prisma returns `date`, `timestamp` and `timestamptz` columns all as Dates, so `run_sql` also selects each row as `row_to_json` to tell them apart: the model gets Central times and plain dates, and the room's table gets UTC ISO (which it shows in Central) and plain dates. `run_sql` can't tell a time the query itself converted to Central from a stored UTC one, so a query that leaves an `AT TIME ZONE 'America/Chicago'` conversion as a timestamp gets a note to select times as stored (or cast the bucket to `date`).

**Room tables** show up to 200 rows, as many as `run_sql` returns, so a whole member list fits.

Two tools run Jack's own SQL, as `jack_readonly` through `JACK_DATABASE_URL` (`src/server/jack/sql-client.ts`):

- **`run_sql`**: one `SELECT` or `WITH … SELECT` he writes. Each runs in its own `READ ONLY` transaction with a 5 s `statement_timeout`, wrapped to return at most 200 rows, inside a savepoint, and then `pg_advisory_unlock_all()` in the same transaction (after rolling back to the savepoint if the query failed), so no session advisory lock outlives it on a pooled connection.
- **`describe_schema`**: reads `information_schema` and the catalog as the same role, so it lists exactly the tables `run_sql` can read.

The role's grants are what keep these read-only and away from secrets: `SELECT` on `public` tables except `SystemSetting` and `_prisma_migrations`, no Supabase `auth`, `storage`, `realtime` or `vault` schemas, read-only sessions, a short timeout (`prisma/migrations/20261013180000_jack_sql_role`).

The role is the primary guard. But Postgres lets every role read its system catalogs and call many server functions, grants or not: database and role settings (`current_setting()`, `pg_settings`, `pg_db_role_setting`, `pg_roles.rolconfig`), function source, trigger arguments, and more through functions like `table_to_xml('pg_db_role_setting', …)`. A database can keep secrets there; local Supabase keeps its JWT secret in `app.settings.jwt_secret`. Production keeps no secrets in its settings or catalogs (checked, read-only), and shouldn't.

As defense in depth on top of that, `run_sql` refuses a query before it reaches the database when it uses, as an identifier (any case, quoted or not; strings and comments don't count, and a `--` comment ends at a newline or a carriage return, as Postgres reads it):

- any name starting with `pg_` (the catalog tables and views, `pg_catalog` itself, and the server's `pg_` functions), except `pg_typeof` and `pg_size_pretty`;
- the XML exports (any name with `_to_xml` or `xmlschema` in it), which read a table, schema, database or query named in a string;
- `current_setting`, `set_config`, the catalog columns `rolconfig`, `useconfig`, `setconfig`, `prosrc` and `probin`, `ts_stat` (it runs a query from a string), the large-object functions (`lo_import`, `lo_get`, `loread`, …, by exact name) and `dblink*`.

Jack gets "Catalog and settings access is off-limits" (`isOffLimitsName` in `src/server/jack/tools/run-sql.ts`). It's a check on names, not a permission, so it narrows what Jack can try; what he can actually read is still whatever `jack_readonly` can, which is why the settings and catalogs shouldn't hold secrets in the first place.

Everything else uses the app's own Prisma client (`DATABASE_URL`), not `jack_readonly`, with fixed, parameterized queries Jack only fills in through each tool's validated input: the typed tools (`club_members`, `member_activity`, `events_overview`, `lsc_entries`, `payments_summary`, `standings`, `audit_log`) only read, `chart` only draws the rows it's given, and `draft_event` is the one write. It creates an event as a `DRAFT` through the admin form's validation, writes an audit log entry credited to the officer whose message started this reply (the newest message it answers), and links to the edit page; publishing stays a human click.

`scripts/check-jack-sql-role.ts` checks all of this against local Supabase: writes, DDL, secrets, other schemas, escalation and the timeout as the role; which catalog reads the role itself can make; then the same through `run_sql`, including the off-limits names (`table_to_xml` on a catalog table, `schema_to_xml('pg_catalog', …)`, `pg_roles`, `pg_user`, a `current_setting` call hidden after a `--` comment ended by a carriage return) and that advisory locks are dropped after a query that works and one that fails. It also warns (without failing) when the database keeps secret-looking settings in `pg_db_role_setting`; local Supabase does by design. It prints setting names only, never values.

## Decks and graphics

Officers can ask Jack for slide decks (meetings, the board, sponsors) and Instagram graphics (posts, stories, carousels) in the club's look (#177). He writes each slide as HTML, the server renders it in headless Chromium, and he looks at the renders and fixes what's off, the way the club's GM and Tech Team decks were made.

**What officers see.** A deck card in the reply (thumbnails at that version, the slides it changed outlined, an **Open** button), and **Admin → Decks and graphics** (`/admin/jack/decks`): every deck, newest first. A deck's page shows every slide large with its notes and a PNG download, the deck's details (size, room, who it was for, what Jack's replies on it cost), its versions (view any; **Restore** makes one the newest again and leaves a note in the deck's room), and downloads of the whole deck: a PDF, a PPTX for Google Slides or PowerPoint (each slide a full-size picture, with the speaker notes) and a ZIP of the PNGs. Changes go through Jack in the room; there's no editor.

**Decks and versions.** A deck is slides at one canvas size: `slides` (16:9, 1920×1080), `post` (Instagram 4:5, 1080×1350), `story` (9:16, 1080×1920) or `square` (1080×1080). A graphic is a deck at a social size, usually one slide. `JackDeck` holds the title, size and current version; every change writes a `JackDeckVersion` with the whole deck as JSON (`{ css, slides: [{ id, html, notes? }] }`), so any change can be undone, by Jack (`deck_restore`) or on the deck page. Changes run in a transaction with the deck row locked (`src/server/jack/decks/service.ts`). Jack's `run_sql` can read both tables.

**The tools** (`src/server/jack/tools/decks.ts`), shaped like file tools:

| Tool | What it does |
|---|---|
| `deck_guide` | The LSR design guide: how slides work, the brand, the kit's classes, layout numbers per size, the templates (`src/server/jack/decks/design-guide.ts`) |
| `deck_assets` | The site's photos, livery renders and logos with what each shows, and gallery photos from Cloudinary, searchable by album and alt text |
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

**The renderer** (`src/server/jack/decks/renderer.ts`): `@sparticuz/chromium` with `puppeteer-core` on Vercel (both in `serverExternalPackages`, the binary traced into the Jack routes with `outputFileTracingIncludes` in `next.config.ts`); the machine's Chrome or Edge locally (or `JACK_CHROME_PATH`). One browser per function instance; each slide renders in its own browser context (pages sharing one go to the background when another closes, and their next screenshot hangs). For each render: a full-size PNG, a full-size JPEG (for the PDF and PPTX), the 1280 px preview Jack sees and the deck page shows, and a 480 px thumbnail.

Slides can't do anything but draw:

- Page JavaScript is off, and the page has a content security policy (`document.ts`). Scripts, meta tags, base URLs, stylesheet links, frames and plugins are stripped from the HTML first.
- Every request goes through `routeRequest`: only Google Fonts, `res.cloudinary.com` and the public site (`www.longhornsimracing.org`; its `/images/` go through the site's image optimizer, so a 6 MB original arrives as a small WebP) load. `https://jack.assets/…` is answered by the server itself: QR codes (`/qr?text=…`) and stored screenshots. Everything else, plain http, other ports and any navigation is blocked, and the check says so.
- Officers only ever see images, never the HTML, so nothing Jack writes runs in a browser.

Site screenshots run the site's own JavaScript (it's the club's site) but only on public pages (never the admin console, sign-in, accounts or the API), only with GET requests, and the browser can't leave the site.

**Storage** (`storage.ts`): a private Vercel Blob store when the project has one connected (`BLOB_STORE_ID` with Vercel's OIDC token, or `BLOB_READ_WRITE_TOKEN`); `.jack-renders/` under the app locally (gitignored); on Vercel without a store, nothing is cached (every image renders again when asked for, and screenshots don't work). Renders are named by a hash of the slide, the deck CSS, the size and `RENDER_VERSION` (`renders.ts`), so they never go stale and a restored version finds its old renders. Exports are kept per deck version. The image route (`/api/admin/jack/decks/[deckId]/slides/[slideId]`) and the export route (`…/export`) check the officer role first, and send anything over 4 MB as a 10-minute signed link to the private store, since a function response can't carry more than 4.5 MB.

**Models, limits and cost.** Any persona can make decks; Jack and Stand mention once that Lift designs better. A reply that calls a deck tool gets the design limits: 30 tool calls, 120K output tokens, and it wraps up 35 s before the answer would be cut off (200 s at most) instead of 60 s, with a short hand-off note. When it stops at a limit with work left, it leaves a room note asking Jack to keep going (`JackMessage.continues`); replies answer these like officer messages, as the officer who asked. The run answers it right away if it has time; otherwise the open room page starts a run for it as soon as nothing is streaming. At most three in a row since an officer last posted. In local tests a 5-slide deck took about 80 s and $0.18 on Jack, a one-slide story 15 s and $0.10. The deck page shows what the replies that changed a deck cost.

**Trying it locally.** `scripts/try-jack-deck.ts "Make a 5-slide deck for GM 2"` asks Jack through the real reply loop on the local database (`--as=lift`, `--room=<id>` for a follow-up) and saves every slide to `.jack-renders/try/`; `--deck=<id> --exports` saves an existing deck and its downloads without calling Claude. It needs `ANTHROPIC_API_KEY` for asking.

## Costs

Prices per million tokens (cache writes are 1.25× input):

| Model | Input | Output | Cache read |
|---|---|---|---|
| Sonnet 5.5 (Jack) | $2 | $10 | $0.20 |
| Opus 5.5 (Lift) | $4 | $20 | $0.20 |
| Haiku 5.5 (Stand) | $0.10 | $0.50 | $0.01 |

Each reply's cost is the sum over its Claude calls (one per tool round) of uncached input, cache writes, cache reads and output at those rates (`src/server/jack/cost.ts`). It's saved on the reply after every call, adding up as the reply goes: `model`, `inputTokens` (everything not read from the cache), `cacheReadTokens`, `outputTokens` and `costUsd`. That includes a call that fails partway (what it reported before failing) and a call asked again after a garbled tool call.

Every Stand call is saved as a `JackUsage` row, whatever came of it: named the room, declined, gave an unusable name, or found the room already named.

The **spend meter** on the rooms page and in each room's header shows this calendar month (Central Time): "October: $3.20 of $50 · Lift $0.90", with Jack, Lift and Stand split out on hover (`src/server/jack/spend.ts`). It adds up the replies and the `JackUsage` rows, as of page load. The eval's calls aren't in it (they show only in the Anthropic Console).

When the month's total reaches `JACK_MONTHLY_BUDGET_USD` (default $50), Jack stops calling Claude and says the budget is used up until the 1st, Central Time. Set a spend limit in the Anthropic Console as well, a little above it, as the hard backstop; it also covers eval runs.

## Environment variables

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude API key. Without it Jack answers "isn't connected yet". Server only; never `NEXT_PUBLIC_`. |
| `JACK_DATABASE_URL` | The connection string for `jack_readonly`, the read-only Postgres role that `run_sql` and `describe_schema` run as (the typed tools and `draft_event` use the app's `DATABASE_URL`; see [Tools and the database](#tools-and-the-database)). Locally `scripts/jack-local-sql-role.ts` sets the role up and prints it. |
| `JACK_MONTHLY_BUDGET_USD` | Optional. Spend cap per calendar month, in dollars. Default 50. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Jack broadcasts replies to the private room channels with it. Locally, `SERVICE_ROLE_KEY` from `npx supabase status -o env`. |
| `BLOB_STORE_ID` | Set by Vercel when a private Blob store is connected to the project; deck renders, exports and screenshots go there (with Vercel's OIDC token). `BLOB_READ_WRITE_TOKEN` works instead. Without either, renders aren't cached on Vercel and screenshots don't work; locally they go to `.jack-renders/`. |
| `JACK_CHROME_PATH` | Local only, optional: the Chrome or Chromium to render slides with, when it isn't installed where the renderer looks. On Vercel the renderer uses `@sparticuz/chromium`. |

## Production setup

1. **Anthropic Console.** Create an API key for the club's workspace, and set the workspace's monthly spend limit a little above `JACK_MONTHLY_BUDGET_USD`.
2. **The read-only role.** The migration creates `jack_readonly` without a login. Make a long random password that's URL-safe, since it goes into a connection string as is: base64url, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (letters, digits, `-` and `_` only; never in git). In the Supabase SQL editor:
   `ALTER ROLE jack_readonly LOGIN PASSWORD '…';`
   Then build `JACK_DATABASE_URL` from the transaction pooler string with the username `jack_readonly.<project-ref>` and `?pgbouncer=true`.
3. **No secrets in database settings.** Any role can read them, so check (names only) that nothing secret is set at the database or role level: `SELECT split_part(s, '=', 1) FROM pg_db_role_setting, unnest(setconfig) AS s;`. `run_sql` refuses these reads by name, but that's defense in depth, not a permission; the secret shouldn't be there at all.
4. **Vercel** (Production): add `ANTHROPIC_API_KEY`, `JACK_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and `JACK_MONTHLY_BUDGET_USD` if the cap isn't $50. Add them to Preview only if previews should answer too (they share whatever database they point at). Redeploy.
5. **Blob store for decks.** In the Vercel dashboard: Storage → Create → Blob, **private**, connected to the project for Production and Preview. That sets `BLOB_STORE_ID`; redeploy.
6. **Check it.** Open a room, ask "How many members are there?", and watch the answer stream with a query part. The function log shows a `[jack] Reply …` line with the cost; the room gets a name from Stand. Then open `/api/admin/jack/render-check` (signed in as an officer): it renders a slide with the real Chromium and should say `"ok": true` and `"store": "blob"` (`?image=1` shows the slide). Finally ask for "a one-slide Instagram story saying GM 2 is Monday": a deck card with a thumbnail appears, and **Open** shows the slide and its downloads.

### Function duration

Posting (or **Ask him to continue**) runs the reply loop after the response, inside the room page's function (Server Actions use their page's settings), so `maxDuration` on `src/app/admin/jack/[roomId]/page.tsx` is **300 s**: Vercel's Fluid compute default and the most the Hobby plan allows (Pro allows up to 800 s). A function can be cut off at that limit without warning, so a run keeps well inside it (`RUN_TIMING` in `src/server/jack/reply-loop.ts`):

- **A run lasts at most 280 s** from the start of the request that started it (the post or the **continue** click, since the function's own limit counts from there). An answer still going then is cancelled (its Claude call and any running tool are aborted, and the reply says it was stopped). After that it only saves the reply, sends its done event (no more deltas) and lets go of the lock.
- **An answer starts only with at least 150 s of the run left.** Otherwise the run lets go of the room's lock and leaves the waiting messages unanswered; the next post, or an officer clicking **Ask him to continue**, starts a fresh run for them.
- **Each answer is cancelled after 240 s** (or at the run's 280 s, whichever is first), and told to wrap up a minute before that (at 150 s at most).
- **Stand** names a room only with at least 20 s of the run left (otherwise a later answer does), and its call is capped at 15 s and cancelled at the run's deadline.

A typical answer takes 5 to 60 seconds, so one run usually answers several rounds of messages. If a function dies anyway, its room lock goes stale after **6 minutes** (`ROOM_LOCK_STALE_MS` in `src/lib/jack/timing.ts`), longer than any live run holds it (it's renewed before each answer). The next run in that room (a post, or **continue**) takes it over and closes the half-written reply as an error. If `maxDuration` changes, change `RUN_TIMING` with it and keep the stale time above it.

A reply working on a deck that runs out of time (or tool calls) leaves a note asking Jack to keep going, and the next run picks it up, from this run if it has 150 s left, or from the room page, which starts one as soon as it sees the note (see [Decks and graphics](#decks-and-graphics)). The deck image and export routes have their own `maxDuration` (60 s and 120 s): a cold start launches Chromium first.

## The eval

`scripts/jack-eval.ts` (questions in `scripts/jack-eval/`) is Jack's test set: 55 questions in ten groups, from what officers ask every day to things he must refuse or could be tricked by. Everyday lookups, harder analysis, vague questions, things he can't do (refunds, email, role changes), things the data doesn't cover, attempts to break him (secrets, a `DELETE`, instructions hidden in an applicant's notes), very large requests, drafting, follow-ups, and design (a GM deck, a recruiting story, a standings post: `scripts/jack-eval/design.ts`). Each goes through the same code a room reply does, on Stand, Jack and Lift.

Design questions run in a throwaway room of their own (decks belong to a room; it and its decks are deleted after). The script checks the deck's size and slide count and renders every slide fresh, failing on any layout problem left; the judge also gets the slides as rendered and grades the design on what it sees. They need a real model and a local Chrome or Edge, so `--dry-run` skips them, and `--regrade` grades them without the images.

Grading has two parts. A script checks what it can against the database: the right number or names, no forbidden tool, nothing changed, no secret in the answer. Opus 5.5 judges the rest against a written expectation and the database facts, blind to which model answered, and with the model's system prompt and each tool's description and inputs, so a claim that comes from them isn't counted as invented. It also grades tool use and notes tools that would have helped. If Opus declines to grade (a question about password hashes trips its checks), Fable 5.1 grades instead. If both decline and the script checks pass, the answer is saved ungraded: it's left out of the pass rate and listed apart, so read it yourself. (A script failure is still a failure.)

Results go to `.claude/hillclimb/jack-<model>/<variant>/` at the repo root (one row and one full transcript per answer) and a comparison of the three models to `.claude/hillclimb/jack-compare/<variant>.md`. That folder holds real member data from the database it ran on and is gitignored; never commit it. Run it on a local copy of production, not on production. `--variant=v1` (v2…) saves a run beside the baseline after a change, to compare.

```bash
# from apps/platform, with DATABASE_URL, JACK_DATABASE_URL and ANTHROPIC_API_KEY in .env.local
pnpm exec tsx scripts/jack-eval.ts                 # everything, all three models: about $6 (about $2.50 for the models, $3 for the judge)
pnpm exec tsx scripts/jack-eval.ts --pilot         # five questions, under $1, to check grades and cost first
pnpm exec tsx scripts/jack-eval.ts --only=jack     # one model
pnpm exec tsx scripts/jack-eval.ts --group=safety  # one group (or --filter=<text> for question ids)
pnpm exec tsx scripts/jack-eval.ts --group=design --only=jack  # the design questions on one model: about $1.50 with the judge
pnpm exec tsx scripts/jack-eval.ts --variant=v1    # save beside the baseline after a change
pnpm exec tsx scripts/jack-eval.ts --regrade       # grade saved answers again after a grader fix (judge calls only)
pnpm exec tsx scripts/jack-eval.ts --regrade --no-judge  # rerun the answer-only checks (TEXT_RECHECK) on saved answers: free, no key
pnpm exec tsx scripts/jack-eval.ts --dry-run       # no API calls: a fake model checks the plumbing
pnpm exec tsx scripts/jack-eval/judge-check.ts     # the judge passes a right answer and fails three wrong ones
```

- It reads only `apps/platform/.env.local` and `.env` (found from the script, wherever it's run from), without overriding the environment.
- It refuses to run unless `DATABASE_URL` is this machine (127.0.0.1 or localhost), or `--allow-remote=<host>` names that exact host, plus `/<project-ref>` for a Supabase pooler URL, since a pooler host is shared by every project in its region (for a copy of real data; never production). `JACK_DATABASE_URL` has to point at the same host and database (and Supabase project). Neither may carry `host=`, `hostaddr=` or `service=` in its query string (Prisma and libpq connect there instead of the URL's host). It prints which database it's on in a banner first.
- It refuses to run without `ANTHROPIC_API_KEY`, except with `--dry-run` or `--regrade --no-judge` (neither calls Claude). A real run's spend doesn't show in Jack's spend meter, only in the Anthropic Console.
- It asks as the first officer or admin (by account age), or `--as=<email|handle>`; the draft is credited to them. The draft question checks the event was created as a DRAFT on the right day and time.
- After the drafting questions (which run one at a time, after the rest) and at the end, it deletes every DRAFT event Jack drafted in the eval's own room (found through the audit entries he wrote for it, from this run or an interrupted one) and those audit entries. On a local database it also plants one fake LSC applicant for the injection question and leaves it there. Nothing else is written.
- Questions with nothing to ask about (no open LSC season, no check-ins yet) are skipped.
- Checks look for the right numbers, names and Central Time dates in the answer, and for a chart whose bars add up. Dates, times and years don't count as numbers ("Oct 13, 7:00 PM" isn't 13 or 7), and a count has to sit next to its noun ("13 paid entries") unless it's the only number in the answer (`src/server/jack/eval-support.ts`). A failure prints what was expected next to the answer.

Run it against a copy of real data before the pilot to pick the default persona, and again after changing the prompt, the tools or a model.

## Tests

`pnpm test` covers Jack without a network or database: the model loop against a scripted fake Claude stream (`src/server/jack/fake-claude.ts`), tool calls and parts, the tool-call cap, refusals, garbled tool calls and API errors, taking back streamed text, usage saved per call, the run and answer deadlines and continuing a room, the missing-key and budget messages, cost math, history building, Stand and its usage rows, trimming big done events, `run_sql`'s off-limits names, the eval's database guard and number matching, and the room reducer that merges live events with snapshots (replacing deltas, trimmed done events, failed resyncs, when a room looks stuck). For decks: the page wrapper and its sanitizing, the request filter, the render cache, QR codes, that the templates only use kit classes and real site images, the write, edit and arrange logic, every deck tool against an in-memory deck table, the design limits, images in tool results, and the automatic continue notes.

With a local Chrome: `scripts/check-jack-render.ts` (every template through the real renderer). Against local Supabase: `scripts/check-jack-sql-role.ts` (the role and `run_sql`, above) and `scripts/check-jack-realtime.ts` (private channels: who can join, two officers watching one reply, presence). The realtime check streams its reply from the fake Claude, so it never calls the API.
