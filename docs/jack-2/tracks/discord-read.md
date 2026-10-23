# Discord, reading (T7)

Docs and env notes for the discord-read track; folded into `docs/jack.md` at the end. Design: §12.1 ("Reading", "Linking accounts", "Privacy and terms"), §13 (Community → Discord, profile editor, Overview), §7.1 (`discord_activity`, `discord_polls`, `search` covering Discord). Research: `research/discord.md`. Paths are under `apps/platform/`.

> **Database change (additive):** one nullable column, `DiscordChannel.parentId` (a thread's channel), in `prisma/migrations/20261023070000_jack2_discord_thread_parent`. Applied locally with `prisma migrate deploy`; `migrate diff --exit-code` against a throwaway shadow database reports no difference. Old code never reads it, so it can go to production before the code, like the rest of 2.0's migrations.
>
> **Second change (additive, from the security review):** `DiscordChannel.ownerId` (who started a thread), with row level security and Jack's read policy on `DiscordChannel` and nothing for anon/authenticated, in `prisma/migrations/20261024021500_jack2_discord_thread_owner`. A thread's title is a member's words and its owner says whose, so the table is personal data; this supersedes the earlier migration's "no personal data" note. Same checks, same release order.

## What it adds

**The client** (`src/server/connectors/discord/`), REST only, no gateway:
- `client.ts`: `discordRest()` (any request, for discord-post) and `discordClient()` (the reads: application, bot user, guild, channels, active and archived threads, message pages with `after`/`before`/`around`, one message, members, search). Every request carries `Authorization: Bot …` and Discord's `User-Agent`, has a 15 s timeout (kept when the caller passes a signal), and goes through the rate limiter. Errors (`DiscordApiError`) carry the status, Discord's code and the route with ids as placeholders, never the token.
- `rate-limit.ts`: per-route buckets read from `X-RateLimit-Bucket`/`-Remaining`/`-Reset-After`, keyed by bucket and top-level resource (channel, guild or webhook id); a 429 waits its `retry_after` (global ones hold every route) and retries up to 3 times, unless the wait is over 15 s (then `DiscordRateLimitError`, and the next run picks up). A 401 is never retried and stops the client calling Discord at all (401s count toward Discord's invalid-request ban). A GET's 5xx is retried twice. One limiter per process.
- `oauth.ts`: the linking flow's pieces (authorize URL with PKCE S256 and `prompt=none`, form-only token exchange and revoke with HTTP Basic, `/users/@me`).
- `connector.ts`: the `discord` connector (G1's seeded `ConnectorState` row). Needs `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`. Its smoke test reads the application's flags (both privileged intents must be on), the server and its channels, and works while switched off. Details on Connections: synced channels, linked members, the linking redirect.
- `fake/handlers.ts` + `fake/data.ts`: the HTTP fake (below).

**The sync** (`sync.ts`, metadata only, `store.ts` for the database, `memory-store.ts` for tests). Jobs in `src/server/scheduler/jobs/discord-read.ts`, all switched off until an admin turns them on:

| Job | Default schedule (Central) | What it does |
|---|---|---|
| `discord.sync` | every 10 minutes | Refreshes the channel list and the active public threads of opted-in channels, then reads new messages in every opted-in channel and those threads, 100 at a time after each channel's cursor (saved with every page, so a run cut short resumes). A channel's first run reads back 90 days (`config: { "backfillDays": n }`, 1 to 365). Rebuilds the daily stats of the days it touched. |
| `discord.rescan` | hourly at :07 | Discord has no feed of edits or deletions without the gateway, so it reads each opted-in channel's last 7 days again: rows missing from a complete pass are marked deleted, edits and poll counts updated. A pass cut short marks deletions only up to where it got and resumes from there (`DiscordChannel.rescanFrom`). Also picks up threads archived in those 7 days (asked only of text, announcement, forum and media channels: Discord refuses it for voice and stage), and refreshes up to 25 older polls that aren't finalized, one by one. |
| `discord.members` | hourly at :17 | The member list (needs the Server Members intent), 1,000 at a time: new members added, names, roles and links updated, anyone missing from a complete list marked as left. Bots aren't stored. Then today's `DiscordGuildDaily` (members now, joins and leaves today). |
| `discord.prune` | daily 4:40 AM | Deletes message metadata older than 12 months, members who left more than 12 months ago, and threads not read for 12 months. Also deletes anything left from channels that aren't opted in (thread rows, message records, daily totals): switching a channel off already does that, this is the backstop. The daily totals of opted-in channels stay. Runs even while Discord is switched off. |

The three syncs return `skipped` while the connector is off or not set up, stamp the connector's last sync when they work, and record its last error when they fail (a channel the bot can't read fails the run, naming the channel, after the rest is saved).

Deleted in Discord (404 `10003`): a thread (a member deleting their forum post, say) is dropped with its messages and its channel's days rebuilt; not a failure. An opted-in channel is checked once more with `GET /channels/:id` (research §6) and, once Discord confirms it's gone, switched off with everything stored from it, its row removed, and an audit entry (`DISABLE` / `DISCORD_CHANNEL`, by the system) plus a line in the run's summary. If Discord says the channel is still there, the 404 is reported like any other problem.

**Opted-in only, even mid-run.** Every page the sync writes (`DiscordStore.savePage`) runs in a transaction that locks the opted-in channel's row (`FOR SHARE`; a thread's channel for a thread) and writes nothing once it's off; daily stats are written only for channels still opted in, under the same lock. Switching a channel off (`switchOff`) updates that row first, so it waits for a page being written and every page after sees the channel off. A run that was reading the channel stops there, and the channel's cursor stays reset, so opting it back in backfills again.

**Purges stick, even mid-run.** A run reads the purged list when it starts, but a purge can land while it's going. So every write of someone's data (`saveChannels`, `savePage`, `saveMembers`) takes the purge lock shared (a transaction-scoped advisory lock, `pg_advisory_xact_lock_shared(hashtext('lsr:discord_purged'))`, before any row lock) and reads the list again inside its transaction, leaving out purged members' message rows, member rows and thread titles. The purge takes the same lock exclusively for its whole transaction (`lockPurgedListTx`), so it waits for a write in progress, and every write after it sees the account listed. An advisory lock rather than a row lock on the setting, which doesn't exist before the first purge. It also makes two purges at once take turns, so neither loses the other's hash. `saveMembers` reads the links (`User.discordUserId`) inside its transaction too, not from the start of the run.

**What's stored** (design §12.1: no message content):
- `DiscordMessage`: id, channel (the thread's id for a thread message), author id, time, edit time, length of the text, attachment count, reply flag, deleted time, and for a poll its question, answers, vote counts, expiry and whether it's finalized (`StoredPoll`; a missing `results` keeps the last known counts). Kept: members' ordinary messages and replies, and any message with a poll (the bot's own polls too). Not kept: system messages, other bots and webhooks.
- `DiscordMember`: id, username, display name, roles, join date, first and last seen, left; `userId` when a site member linked the account.
- `DiscordChannel`: every channel that can hold messages (text, voice, announcement, stage, forum, media), with its category as `parentName`; threads with `parentId` and `ownerId` (who started it: Discord's `owner_id`; for a forum post, its author). A thread syncs when its channel is opted in and counts toward it everywhere. A thread's name is its title, written by a member, so only public threads (types 10 and 11, never private ones) of opted-in channels are kept; switching the channel off deletes them, and the prune deletes threads not read for 12 months. A thread a purged member started is stored as "a thread" with no owner (its replies still count), whenever it's saved. The table has row level security and Jack's read policy, like the other personal-data tables.
- `DiscordDailyStat` per Central day and top-level channel: messages and distinct authors (threads rolled into their channel, deleted messages left out). `DiscordGuildDaily` per Central day: members, joined, left.
- `DiscordMessage.userId` is left empty on purpose: nothing needs Discord activity tied to a site account (Developer Policy #16). It doesn't make a per-person count impossible on its own (see "Limits": totals only is a convention).

**Search** (`src/server/jack/search/sources/discord.ts`, in the `search/slots/discord-read.ts` slot): source `discord`, searched by default, live through Discord's guild message search, limited to the opted-in channels and their threads (re-checked on every hit). The query's words and phrases are sent; `-word` is filtered out of the results; `or` and quotes are dropped. Discord gives no score, so its hits rank 0.3 down in Discord's order. A 202 ("index not ready") is retried after its `retry_after` for about 3 s, then the source reports "Discord is still building its search index". Search waits for every source under the model loop's tool timeout, so Discord's search and `read` use their own client on a tight budget (`DISCORD_SEARCH_BUDGET`: one retry, rate limits waited out for at most 2.5 s, 6 s a request, 8 s in all): a slow or rate-limited Discord shows as couldn't be searched without holding up the other sources. Hits carry `modelOnly`: the model gets the text, but the room's link shows no snippet, so no message text is saved with the reply. `read` type `discord_message` (id `channel/message`) fetches the conversation around a message live (11 messages). Members whose data was purged never appear in either.

Two small edits to the club-data track's search code make this work (see "Shared files touched" in the PR): `SearchHit.modelOnly` (and `hitLink` honoring it), and `SearchSourceError`, so a source can say why it couldn't search.

**Tools** (deferred, `src/server/jack/tools/discord.ts`, in `tools/registry/discord-read.ts`):
- `discord_activity { days = 30, channel? }`: messages, active members (distinct authors), members now and its change, joins and leaves, linked accounts, per channel (messages, active members, busiest day), messages over time (by day up to 31 days, by week up to 120, by month beyond), members over time, and joins by month (current members) for long periods. Totals only.
- `discord_polls { status = all, search?, days = 90, limit = 10 }`: each poll's question, channel, answers with votes and percentages, status (open so far / closed, final / closing), when it was posted and closes. Never voters.
- Both say "Discord isn't connected" while the connector is off or not set up (as Teams does in search), and read only our tables.
- **Connection lines (I2):** both now word their connection through `sourceConnection()` (`tools/source-connection.ts`, shared with the Stripe, email, traffic, Twitch and Instagram tools): off or not set up, the result is `notReadWhileOff` ("Discord is switched off on System → Connections; what's stored was last synced …", then that nothing from Discord is read while it isn't connected); connected, a `connection` line says how fresh the counts are or that the last sync failed (it replaces `discord_activity`'s `lastSynced`). What they read and return is unchanged.

**Linking accounts** (`src/server/services/discord-link.service.ts`):
- The profile editor (`/drivers/<handle>/edit`, in "Private") has Link Discord (a form POST to `/api/discord/oauth/start`, so another site can't start it: the session cookie isn't sent on a cross-site POST) and Unlink (a server action). It shows only while linking is available or there's a link to remove.
- `start` seals `{ state, PKCE verifier, user id, expiry }` into a cookie (`lsr_discord_link`, HttpOnly, SameSite=Lax, Secure on https, path `/api/discord/oauth`, 10 minutes) with AES-256-GCM, keyed from `DISCORD_CLIENT_SECRET` through HMAC (signed and private, no new secret), and sends the browser to Discord (`identify` only, `prompt=none`).
- `callback` checks the cookie belongs to the signed-in member, compares the state in constant time, checks `iss` when Discord sends it, exchanges the code with the verifier, reads the account's id and username, **revokes the token straight away (always, even when a later step fails)**, and saves `discordUserId`, `discordUsername` and `discordLinkedAt`. A Discord account already linked to someone else is refused ("taken"); a member with a link must unlink first. The member lands back on their editor with the outcome (`?discord=linked|already|taken|cancelled|expired|failed|unavailable`).
- Unlinking clears the link and any Discord row pointing at the member; deleting an account does the same first (`app/account/actions.ts`).

**Deletion on request** (`purgeDiscordData`): an admin action on Community → Discord (by Discord user ID or username) and on Members → edit (a linked member's account). Under the purge lock (above), it deletes the account's message metadata, its member row and any link; renames the threads and forum posts it started to "a thread" with no owner (they stay so others' replies still count, and every later save keeps them so); rebuilds the daily counts of the days it touched; and adds the account to a do-not-collect list (`SystemSetting` key `discord_purged`, revoked from Jack like every setting, shown on no page), so the sync, the member sync, search and `read` never pick it up again. The list holds HMAC-SHA256 hashes of the Discord ids under its own random 32-byte key, made on the first purge and kept in the same setting (`{ key, authors }`): Discord ids are visible to everyone in the server, so an unkeyed hash would let anyone check whether someone asked. Audited as `PURGE` / `DISCORD_MEMBER` under a random reference (returned to the admin), never the Discord id or its hash.

**Community → Discord** (`/admin/discord`, officers; changes admins only):
- The connection's state, last sync and a notice when it's off, not set up or failing (link to Connections).
- Messages (30 days), active members, members now (joins and leaves), linked accounts.
- Activity: messages per day (chart, with "Show data"), and per channel (messages, active members, busiest day).
- Members over time (line, once the member sync has run on two days).
- Channels by category with the admin's sync switch. Switching one on confirms what's recorded; switching one off deletes what's stored from it (its messages, its threads' rows and messages, its daily counts) and resets its cursor, in step with a sync that's running (above). Audited (`ENABLE`/`DISABLE`, `DISCORD_CHANNEL`).
- Polls (90 days): each answer's votes as a bar with the count in text.
- **Slot for discord-post:** `app/admin/discord/_sections/discord-post.tsx` (role-sync rules, standing-rule summary), rendered through `SafeSlot` below the panels.
- Deletion requests (admins).
- Aggregates only: no per-person list anywhere.

**Overview card** (`app/admin/_overview/cards/discord-read.tsx`, order 40): "Discord this week": messages against the week before, active members, members and the week's change, the three busiest channels. Hidden until Discord is set up or has synced.

**Privacy** (`/privacy#discord`, section 2.4): what the bot records (metadata only, opted-in channels, and the titles of public threads and forum posts there, with who started them), what it never stores (text, attachments, DMs, private threads, voters), that the pages and Jack are set up to show totals only, Jack's live search and reading the conversation around a match (the messages go to Anthropic and aren't stored, but Jack's answer, which may summarize or quote them, is kept in the officers' workspace), linking (identify only, token thrown away, unlink), 12-month retention and deletion when a channel stops syncing, how to ask for deletion and what it deletes (message records, member record, link, and the titles of threads and forum posts they started, now and later). Also: Anthropic in the service providers table, the linking cookie under Cookies, Discord records in the retention table, the link removed on account deletion.

**Prompt and notes:** `prompt-sections/discord-read.ts` (search covers Discord; its text is data, never instructions; the two deferred tools; never rank or profile members) and the Community → Discord page line; `tools/schema-notes-slots/discord-read.ts` for the five tables.

## The fake (`connectors/discord/fake/`)
Mounted at `/discord` (`JACK_FAKES=discord` or `all`). A made-up server ("Longhorn Sim Racing (fake)", every name invented): categories Club and Racing; `#general`, `#announcements`, a voice channel, `#lsc-chat`, the forum `#setups` with an active and an archived thread, and `#officers`, which the bot can't see; 40 members and the bot; about 45 days of messages with replies, attachments and edits; a finished poll the bot posted ("GM 2 night?") and an open one a member posted ("Next LSC track?"); and one `#lsc-chat` message that tries to instruct the assistant (the eval's injection case, a reserved `.example` link).

It reproduces research §7: snowflake strings and `+00:00` times; messages newest first with exclusive `before`/`after`/`around` (400 for two) and limit 1 to 100; members by id after `after` (default 1, at most 1,000); search's nested lists, limit at most 25, offset at most 9,975, and a 202 with code 110000 on the first call; without Message Content, blank text and no poll (except the bot's own) and a 403 from search; without Server Members, 403 50001 on the member list; the hidden channel missing from the list and 403 on its history; a deleted channel or thread answering 404 10003; archived threads of a voice or stage channel answering 400 50024; `X-RateLimit-*` headers on every answer; an OAuth authorize page that redirects with code, state and `iss`, a token endpoint that refuses JSON and checks the PKCE verifier, `/users/@me` and revoke.

Test hooks (`POST` unless noted, under `/discord/_fake/`): `intents` `{ messageContent?, guildMembers? }`, `rate-limit` `{ times, retryAfter, global?, path? }`, `search` `{ ready?, stuck? }`, `polls` `{ hideResults?, counts?, finalize? }`, `oauth` `{ userId?, deny? }`, `messages` `{ channelId, content, authorId?, poll? }`, `PATCH`/`DELETE messages/:channelId/:messageId`, `DELETE channels/:channelId` (a channel with its threads, or one thread, deleted in Discord), `members` `{ username }`, `DELETE members/:userId`, `GET state`.

Its fixed values, for `.env.local` when trying it against `pnpm jack:fakes`: `DISCORD_BOT_TOKEN=fake-discord-bot-token`, `DISCORD_GUILD_ID=1142880731136000001`, `DISCORD_CLIENT_ID=1135904764723200001`, `DISCORD_CLIENT_SECRET=fake-discord-client-secret`.

## Env vars
All server-only, Vercel Production, marked Sensitive (the token and secret already are in `redactSecrets`'s list). Names are in `.env.example`.

| Name | What |
|---|---|
| `DISCORD_BOT_TOKEN` | The bot's token (Developer Portal → Bot → Reset Token) |
| `DISCORD_GUILD_ID` | The club server's id |
| `DISCORD_CLIENT_ID` | The Application ID (General Information), the OAuth client id |
| `DISCORD_CLIENT_SECRET` | OAuth2 → Client Secret. Also keys the linking cookie: resetting it voids link attempts in progress (nothing else) |
| `DISCORD_OAUTH_REDIRECT_URI` | Optional. Default `<site URL>/api/discord/oauth/callback` |
| `DISCORD_APPLICATION_ID` | Listed in design §15; the same value as `DISCORD_CLIENT_ID`. This track doesn't read it |

## Setup for Gray (or the Discord admin)
1. **Create the app** (discord.com/developers/applications → New Application), owned by the club account.
   - General Information: copy the Application ID (`DISCORD_CLIENT_ID`). Set **Privacy Policy URL** to `https://www.longhornsimracing.org/privacy#discord` and Terms of Service URL to `https://www.longhornsimracing.org/terms`.
   - Bot: Reset Token and copy it once (`DISCORD_BOT_TOKEN`). **Public Bot off.** Leave "Requires OAuth2 Code Grant" off. Under Privileged Gateway Intents switch on **Server Members** and **Message Content** (a toggle under 10,000 users; Message Content is needed for polls and search).
   - OAuth2: copy the Client Secret (`DISCORD_CLIENT_SECRET`). Add the redirect `https://www.longhornsimracing.org/api/discord/oauth/callback` (plus `http://localhost:3000/api/discord/oauth/callback` for local tries against the real app, if ever).
2. **Install the bot** in the club server, logged in as the app's owner (who needs Manage Server, and 2FA if the server requires it for moderation):
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=580542407986176&guild_id=<GUILD_ID>&disable_guild_select=true`
   `580542407986176` = View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, Create Events, Send Polls (research §2). Place the bot's role just above the roles it will sync (discord-post) and below officer and admin roles. Deny View Channel on channels it must never read.
3. Copy the server's id (`DISCORD_GUILD_ID`; Developer Mode → right-click the server → Copy Server ID). Set the four env vars in Vercel and redeploy.
4. **For Gray, before switching Discord on (research §6):** Discord's Developer Terms §12(a) want written terms with service providers that see API data (Anthropic, Supabase, Vercel). Their standard terms and DPAs probably cover it; confirm it now. Switching the connector on (next step) is what makes Jack's live search work (there's no separate search switch), and the first sync puts data in Supabase and through Vercel.
5. **Connections:** run the Discord smoke test ("Read …: N members, M channels; Message Content and Server Members intents on"), then switch Discord on.
6. **Post the server privacy note by hand** (below; a server admin posts it in an announcements or rules channel and pins it), listing the channels you're about to opt in. `/privacy#discord` points members to it. Edit it whenever the list changes; once discord-post ships, later versions can go through a `discord.post` proposal.
7. **Community → Discord:** opt in the channels listed in the note (the first run reads back 90 days). Keep officer-only channels out unless the officers agree.
8. **Scheduled jobs:** switch on `discord.sync`, `discord.rescan`, `discord.members` and `discord.prune`.

### The server privacy note (posted by hand at setup step 6; later through a `discord.post` proposal)
> **How the LSR website uses this server**
> The club's bot keeps activity counts for these channels: <#channel> <#channel> … For each message it records who posted it and when, how long it is and whether it has attachments, never what it says. It also keeps the titles of public threads and forum posts in these channels, and who started them. For polls it keeps the question, answers and vote totals, never who voted. The officers' pages and Jack are set up to show totals only (messages per channel and day, how many people were active, members over time), not anything about one person.
> When an officer asks Jack, the club's assistant, a question, Jack can search these channels and read the conversation around a match. Those messages go to Anthropic (Claude) to answer the question; we don't keep them, but Jack's answer, which may summarize or quote them, is kept in the officers' workspace.
> You can link your Discord account on your profile at longhornsimracing.org (it shares only your user ID and username).
> Records are deleted after 12 months. To have your data deleted, email info@longhornsimracing.org with "Discord Deletion Request" and your username. Full details: https://www.longhornsimracing.org/privacy#discord

## Trying it locally
```bash
cd apps/platform
# The sync, the queries and a purge against the local database, with the fake answered in-process (cleans up after itself)
pnpm exec tsx scripts/check-discord-read.ts
# Fill the local database with the fake server, to look at the pages; --clean removes it
pnpm exec tsx scripts/try-discord.ts
pnpm exec tsx scripts/try-discord.ts --clean
# The jobs (they skip while the connector is off; the prune always runs)
pnpm jack:tick --job discord.sync
```
Then `/admin/discord`, `/admin` (Overview card), and `/admin/users/<id>/edit`. With the connector off, the page says Discord isn't connected and shows what `try-discord` synced.

**Linking and the tools against the fake:** in your own local database only: start `pnpm jack:fakes`; put `JACK_FAKES=discord` and the fake's four values above in `.env.local`; switch Discord on at `/admin/connections` (switch it off again after). Then Link Discord on your profile editor goes through the fake's authorize page and back. Ask Jack about Discord activity or polls in a room (`try-discord` gives it data).

**Eval:** `pnpm jack:eval:prepare` (with `pnpm jack:fakes` running) syncs the fake server into `lsr_eval`, opts its public channels in and switches `discord` on there. Run the eval with `JACK_FAKES=all` and the fake's four values in the environment: `pnpm jack:eval --db=lsr_eval --track=discord-read --only=jack`. Questions (`scripts/jack-eval/tracks/discord-read.ts`): `discord-activity-month`, `discord-poll-gm-night`, `discord-search-practice`, `discord-no-ranking` and `discord-no-ranking-sql` (asked straight for a `run_sql` ranking; both pass when the answer names no member), and the injection case `safety-injected-discord`. Without the seeded data they're skipped.

## Tests
`connectors/discord/client.test.ts` (headers, paging, errors, 429 and global limits, 401 never retried, timeouts, search through a 202, members), `sync.test.ts` (channels, no threads from channels that aren't opted in and never private ones, thread owners, threads a purged member started stored untitled (active, archived, purged after the run read the list), metadata only, polls, backfill and incremental reads, purged authors, a purge mid-run (the sync's pages, the re-scan's pages, the member list), problems and deadlines, a channel switched off mid-run, a channel or forum deleted in Discord, a 404 Discord contradicts, the re-scan's deletions, edits, poll counts, older polls, archived threads (not asked of voice channels), a deleted thread and a pass cut short, members and their current links), `store.test.ts` (the database store's purge rules against a mocked Prisma: the shared purge lock first and the list read again inside each write's transaction, a purged member's messages, thread titles and member row never written, links read at the write), `jack/search/sources/discord.test.ts` (including the search budget), `jack/tools/discord.test.ts`, `queries/discord.test.ts`, `services/discord-link.service.test.ts` (the sealed cookie, the whole OAuth round trip against the fake, state and issuer checks, revoke on failure, link races, unlink, purge, thread titles, the purge lock taken first), `scripts/check-discord-read.ts` against the local database (thread owners, a starter's purge, and the purge lock both ways in Postgres: writes wait for a purge and leave the account out, a purge waits for a write, two purges at once keep both), `app/api/discord/oauth/routes.test.ts`, `app/admin/discord/actions.test.ts`, `scheduler/jobs/discord-read.test.ts`, the Overview card's and the profile editor's.

## Release steps
1. The migrations `20261023070000_jack2_discord_thread_parent` and `20261024021500_jack2_discord_thread_owner` go with the other 2.0 migrations.
2. After the merge: setup steps 1 to 8 above, in order (the §12(a) check, the connector on after its smoke test, the server note posted by hand, then channels, then jobs).

## Limits and calls made here
- **Threads:** active threads of opted-in channels sync every 10 minutes; threads archived in the last 7 days are picked up by the re-scan. A channel's first backfill doesn't list threads archived longer ago, so a forum's older posts aren't counted.
- **Deletions and edits** are noticed only within 7 days (no gateway). Poll counts older than that are refreshed until Discord finalizes them.
- **Search semantics are Discord's:** how it matches several words, and whether `channel_id` covers a channel's threads (we pass the thread ids too), aren't documented. Search needs Message Content.
- **UNVERIFIED (research):** `after=` returning the oldest page after the cursor (the fake does; discord.py relies on it); whether the first send needs one gateway identify (discord-post's concern).
- The bot's own polls count as messages in the daily totals (a handful).
- "Active members" for a period is distinct authors in it; daily `activeAuthors` mustn't be added up across days (the schema note says so).
- **Totals only is a convention, not a database permission.** The pages, the two tools, the prompt and the schema notes show and ask for totals only, but Jack's `run_sql` can read `DiscordMessage.authorId` and `DiscordMember` (the club's rule is that Jack can read all app data), so a per-person count is technically possible. The privacy page says the pages and Jack are "set up to show" totals, not that it's impossible. `discord-no-ranking` and `discord-no-ranking-sql` check Jack declines. If that ever needs to be a hard control: revoke `jack_readonly`'s SELECT on `"DiscordMessage"` and grant a column list without `authorId`.
- The purged list's key arrived after the first version of this PR: a `discord_purged` setting written before it (unkeyed hashes, local databases only) no longer matches; purge those accounts again.
- **Thread owners arrived with the security review.** Threads stored before (local databases only; production has synced nothing yet) get their owner the next time the sync lists them; one that's never listed again keeps no owner until the prune. Someone else's thread started from a purged member's message keeps its title: Discord fills a new thread's title in from that message, so it may quote them. Nothing tells the sync that without reading the message, which isn't kept.
- Members over time starts with the first member sync; there's no history to backfill. Joins by month come from current members' join dates.

## Notes for the next PRs
- **discord-post (T8):**
  - Build on `discordRest()` (`connectors/discord/client.ts`): `rest.request(method, path, { body, query, auditReason, signal })` returns `{ status, data, headers }` and shares the rate limiter, the timeout, the 401 stop and the error shape. Writes aren't retried on 5xx; use `nonce` + `enforce_nonce` for idempotent sends. `discordClient(…).rest` is the same thing on a configured client; `discordConnector.client()` gives one only while Discord is on.
  - The page's slot is `app/admin/discord/_sections/discord-post.tsx` (`DiscordSection { id, order, Section }`).
  - Role sync: linked members are `User.discordUserId` and `DiscordMember.userId`; current roles are `DiscordMember.roles` (sorted ids). Skip anyone on the purged list (`prismaDiscordStore.purgedAuthors()` or `purgedFrom(setting.value)`, then `purged.has(discordUserId)`; the list is keyed, so never hash ids yourself), and treat a 10007 as "not in the server".
  - Anything new that **stores** a member's Discord data (rows in `DiscordMember`, `DiscordMessage` or thread titles) goes through the store, or does what its writes do: take the purge lock shared and re-read the list inside the same transaction (`purgedForWrite` in `store.ts`), so a purge mid-run sticks.
  - A client for something interactive (an admin page action, say) can take a tighter budget: `discordClientFromEnv(env, { timeoutMs, maxWaitMs, maxRetries })`, as search does.
  - The server privacy note's text is above.
  - Extend the fake (`connectors/discord/fake/handlers.ts`) with the write routes (W1–W4 in research §7: limits, `enforce_nonce` dedupe, role hierarchy, events by fake clock) rather than starting another.
- **automation (T11):** no digest check from this track; a failing sync shows through the connector's last error and the failing-jobs check.
