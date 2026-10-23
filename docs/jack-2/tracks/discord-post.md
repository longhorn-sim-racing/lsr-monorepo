# Discord, posting (T8)

Docs and env notes for the discord-post track; folded into `docs/jack.md` at the end. Design: §12.1 "Posting" (all), §4.3 (`discord.post`, `discord.rule`), §7.1 (`propose_discord`, deferred), §13 (Community → Announcements, and role sync on Community → Discord), §11.2 (the digest posts through this track). Research: `research/discord.md`. Paths are under `apps/platform/`.

> **No database change.** Every table was already in the schema (`DiscordRule`, `DiscordPost`, `DiscordEventMirror`, `DiscordRoleRule`). The posting channels are a `SystemSetting` row (`discord_posting`).

## What it adds

**The posting surface** (`src/server/connectors/discord/write.ts`), on top of discord-read's REST client (`discordRest()`), so writes share its rate limiter (per route bucket, from `X-RateLimit-*`), its timeout, its 401 stop and its error shape; nothing about reading changed:
- `discordWriter(rest, guildId)`: create a message (always with `nonce` + `enforce_nonce: true`), read a channel's recent messages, end the bot's own poll, list roles, read a member, add or remove a member's role (with `X-Audit-Log-Reason`), and list, create, edit and delete external scheduled events (`with_user_count`).
- `messageProblems(body)`: Discord's limits (research §3 W1, W2): 2,000 characters, 10 embeds and 6,000 characters across them, field and footer limits, polls of 1 to 10 answers up to 55 characters, a question up to 300, 1 to 768 hours.
- Role safety: `MODERATION_PERMISSIONS` (Administrator, Kick, Ban, Manage Channels, Manage Server, View Audit Log, Manage Messages, Mention @everyone, Mute, Deafen, Move Members, Manage Nicknames, Manage Roles, Manage Webhooks, Manage Expressions, Manage Events, Manage Threads, Timeout Members, Creator Monetization Analytics; BigInt bits), `roleSyncRefusal()` (no @everyone, no managed role, no role with any of those, nothing at or above the bot's highest role) and `botRoleProblem()` (the bot's highest role must sit below every role with Manage Server or Manage Roles, and the bot must not hold Administrator).
- **The smoke test checks the bot's role** (one shared edit in discord-read's `connector.ts`): after the intents, it reads the roles and the bot's member and fails with "move it below the admin roles" or "has Administrator".

**The outbox** (`src/server/discord-post/outbox.ts`). Every message the bot posts is a `DiscordPost` row first, whoever made it (`source`: `rule`, `proposal`, `admin` for an officer on Announcements, `digest` for the weekly digest):
- `queueDiscordPost()`: one row per `dedupeKey` (`proposal:<id>`, `event_reminder:<rule>:<event>:<start ISO>:<minutes>`, `new_event:<rule>:<event>`, `results_posted:<rule>:<event>`, `standings_update:<rule>:<season>:<audit entry>`, `twitch_live:<rule>:<stream>`); a taken key returns the post that holds it. Each post gets its own `nonce` (25 characters from its id). Refuses a message over Discord's limits.
- **The SENDING claim**: `claimPost()` is one conditional update (`SCHEDULED → SENDING, claimedAt` where it's due), so of a run and an Apply, or two runs, exactly one sends it.
- **No double posts**: a send whose answer never came (a dropped connection, a timeout, a 5xx) is tried again at once, twice, with the same nonce; Discord returns the first message instead of posting again for a few minutes. If it's still unconfirmed, the channel's recent history is read: the bot's message with the same text (and poll, and first embed) means SENT; none means FAILED with "check the channel, then retry". It's never re-sent blind after that (the message might have been posted and deleted). A run cut off by its deadline mid-send leaves the post SENDING; the next run checks the channel for it after 3 minutes.
- A 4xx refusal fails the post at once (nothing was posted; the error is in words: Missing Access, Missing Permissions, unknown channel, invalid body). A rate limit longer than the client waits puts it back to SCHEDULED for the next run (Discord didn't take it).
- Errors are stored through `redactSecrets()`.
- `sendDuePosts()` (the posts job): checks posts a stopped run left SENDING, cancels posts more than **6 hours late** (Discord was off, or the scheduler stopped), then sends up to 10 due posts, oldest first, each checked first (its channel is still a posting channel; a rule's post is still wanted).
- `cancelPosts(where, reason, { release })`: an officer's cancel (or a missed time) keeps the dedupe key, so a rule never posts it after all; a cancel because something changed (an event moved or was cancelled, a rule paused or edited) frees it (`dedupeKey` null), so it can come back.

**Posting channels** (`channels.ts`): admins pick the server's text and announcement channels the bot may post in, on Announcements (audited, `DISCORD_POSTING`). Every proposal, rule and officer post is checked against the list when it's made and again right before it's sent.

**`discord.post`** (`src/server/jack/proposals/discord-post/post.ts`, on `propose_discord`, deferred): an announcement and/or a poll in a posting channel, now or at a Central time (up to 30 days ahead). Any officer applies it; the card asks first (`destructive`).
- **Template check** against the room's officer messages (every officer's own messages in the room, newest 200; never Jack's replies or room notes): a mention (`@everyone`, `@here`, `<@id>`, `<@&id>`) stays only if an officer's message has the same one; a link stays if it points at the club site (or a subdomain) or an officer's message has it (compared without `www.` and a trailing slash, never by host alone); everything else comes out (a masked link keeps its words), and the card says what came out and from which hosts. Channel links (`<#id>`) stay; they ping nobody.
- **Pings**: only the named `ping` field pings (a role by name, or `everyone`/`here`), and only when an officer asked for it in the room (their message has the mention, or says ping/tag/mention/notify with the role's name or "everyone"). `@everyone`/`@here` also need the bot to hold Discord's Mention @everyone permission (the install link doesn't give it); a role must be pingable by anyone, or the bot needs that permission. `allowed_mentions` is `{ parse: [] }` otherwise, so text mentions never ping.
- The card shows the message as it will be posted (channel and role mentions by name, links with their hosts), the channel, the ping and the time. **Apply posts exactly that** (saved in `before`), not a fresh copy of Jack's text. Stale when the channel stops being a posting channel or a scheduled time passes.
- Apply queues the post keyed `proposal:<id>` (so a second Apply posts nothing: "Already posted"), audits it (`DISCORD_POST`, with the proposal's `auditMetadata`), and sends it right away (or leaves it scheduled); the room note links Announcements and the Discord message.
- A newer post proposed for the same channel replaces a pending one (`targetId` `channel:<id>`).

**`discord.rule`** (`rule.ts`, admins only): create or change a standing rule (types below), with its channel, offsets, series, top, a role ping (officer must have asked; never @everyone) and location; switched on when applied unless it says `enabled: false`. Edits are conditional on the rule's `updatedAt` (stale otherwise) and can't change a rule's type. One event mirror at most.

**Standing rules** (`rules.ts`, `rule-runner.ts`, `templates.ts`). **One dispatcher job** (`discord.rules`, every 5 minutes) runs every switched-on posting rule and queues posts; the posts job sends them; the event mirror has its own job. Fixed templates only (every word is in `templates.ts`; values go through `templateValue()`: one line, no mentions, no links, Markdown escaped), public events only (`isEventPublic`, plus not cancelled or postponed), and never an event's meeting link (the event select doesn't read `meetingUrl`).
| Kind | Acts on | Posts |
|---|---|---|
| `event_reminder` | Public upcoming events; 1 to 3 offsets (15 minutes to 7 days); scheduled up to 8 days ahead; a reminder whose time passed less than 15 minutes ago still goes | "Reminder: **GM 2** starts in 1 hour" and the event's card (when in Discord time, venue, registration if open, the event page) |
| `new_event` | Events that became public after the cutoff (published, or past their publish time), starting in the future | "New event: **GM 2**" and the card |
| `results_posted` | Results ingested after the cutoff (the `INGEST` audit entries), once the event has race results | The race's top three and a link to the results |
| `standings_update` | Lone Star Cup standings recomputes after the cutoff (the "Recomputed standings" audit entries, as the standings tool reads them), public seasons only | The top 3 to 10; skipped when the top didn't change |
| `twitch_live` | The stream that's live now, started after the cutoff | "Longhorn Sim Racing is live on Twitch" with its title (outside text: stripped) and the channel |
| `event_mirror` | Upcoming public events (60 days) | Discord scheduled events (below) |
- **Cutoff**: a rule acts only on what happens after its `cutoffAt`, which is set when it's created and **moved to now whenever it's switched on again**, so a paused rule never catches up. Each run also looks back at most 3 days, so a stopped scheduler never floods the channel.
- **Caps**: at most 3 new posts per rule per run (20 reminders).
- **Reminders and reschedules**: the key holds the event's start time, so a moved event gets new reminders; each run cancels pending reminders whose event moved, was cancelled, postponed, unpublished or deleted, or whose offset the rule dropped (freeing their keys, so an event moved back gets its reminders again). A pending reminder's text is refreshed when the event's title, venue or registration changes.
- **Twitch**: the stream that's live now, from sources-b's stream rows (`currentLiveStream` in `connectors/twitch/streams.ts`: open and seen in the last 15 minutes), if it went live after the cutoff; waits up to 2 minutes for the title (Twitch fills it in a few seconds after going live); a stream that started within 15 minutes of the previous one ending is a reconnect, not posted again; rows the daily snapshot adds from old VODs are ended, so never posted. Up to about 5 minutes after going live (the job's cadence).
- **The last check before sending** (`rulePostProblem`): the rule still exists, is on and posts in that channel; the event is still public, not moved, not started (reminders, new events); the stream is still live.
- Pausing a rule (any officer) cancels its scheduled posts; deleting one (admins) cancels them and keeps what it posted. Every change is audited (`DISCORD_RULE`: CREATE, UPDATE, ENABLE, DISABLE, DELETE).

**Event mirror** (`event-mirror.ts`, job `discord.event-mirror`, every 15 minutes, while an event mirror rule is on): creates an external Discord event for each upcoming public event (name, summary and the event page, start and end, the venue as location or the rule's location; never the meeting link), edits it when the event changes, deletes it when the event is cancelled, postponed, unpublished or deleted before it starts (past ones are left; Discord completes them), leaves alone one an admin deleted in Discord, at most 10 writes a run, and reads `user_count` into `DiscordEventMirror.interestedCount`. **The interested counts show on Community → Discord** ("Events on Discord"), not on the event's admin page (no shared edit to the events pages).

**Role sync** (`role-sync.ts`, job `discord.role-sync`, hourly at :27, after discord-read's member sync at :17): linked members (`User.discordUserId`, not deleted, never on the purged list) get a rule's Discord role while they meet its condition and lose it when they stop. Conditions: linked members, officers (officer or admin), the LSC Driver badge, the Collegiate Series badge, entered in the open LSC season (paid or added by an officer; nothing changes while no season is open). Only members the member sync has seen in the server (`DiscordMember.roles` is what they hold), only what differs, at most 25 changes a run. The role is checked live every run (`roleSyncRefusal`); Discord's own 50013 stops a rule. Every change is audited (`ROLE_ADD`/`ROLE_REMOVE`, `DISCORD_ROLE`, the member as target, the system as actor; no Discord id in the entry). One rule per role. Rules are managed on Community → Discord (admins; audited `DISCORD_ROLE_RULE`); deleting a rule leaves the roles it handed out.

**Community → Announcements** (`/admin/announcements`; officers see everything):
- Standing rules: each with its description, on/off, what it acts after, scheduled count, last post. Admins: New rule (a form per kind), edit, switch on (asks first), delete. Any officer: pause.
- Posts (Scheduled, Sent, Failed and cancelled, All; paged): status, channel, when, where it came from (a rule, "Jack, applied by …" linking the room's reply, an officer, the weekly digest), its ping, errors, the message in a dialog, Open in Discord. Any officer: cancel a scheduled post (asks first), send a failed one again (asks first: "look in the channel first"; same nonce).
- New post (officers, while Discord is on and channels are set): channel, text (as typed), optional poll, optional ping from the roles the bot may ping, now or a Central time; asks before posting. Audited.
- Waiting for approval: pending `discord.post` and `discord.rule` proposals, linking their rooms.
- Posting channels (admins change them).
- **The server privacy note**: discord-read's text (`docs/jack-2/tracks/discord-read.md`) with the synced channels filled in as channel links. "Copy for Jack" copies "Propose a Discord post in #<channel> with exactly this text, no ping …" plus the text; paste it in a Jack room and Jack proposes it as a `discord.post`, which an officer applies (the officer's own message has the text, so nothing is stripped). "Post it myself" opens New post with it filled in. Post it again whenever the synced channels change.

**Community → Discord** (the slot discord-read left, `app/admin/discord/_sections/discord-post.tsx`): Role sync (rules with the role's live name, condition, who qualifies and holds it, refusals; admins add, switch and delete), Events on Discord (mirrored events with interested counts), and Posting to Discord (the rules that are on, a link to Announcements).

**Jack**: the `propose_discord` tool (deferred; built from the two kinds), a prompt section (`prompt-sections/discord-post.ts`: how to propose, the stripping and ping rules, rules are templates, check `DiscordRule` before proposing a twin) and the Announcements page line, and schema notes for the four tables. Jack reads rules and posts with `run_sql`; the posting channel list is a setting he can't read, so the `discord.post` error lists the channels.

**Digest check** (`automation/checks/discord-post.ts`): "Discord posts that failed" in the last week (the channel and where each came from; never the text or the error), linking `/admin/announcements?view=problems`.

## Jobs
All four skip while Discord is off or not set up (due posts wait, and are cancelled once they're 6 hours late), and are switched off until an admin turns them on.
| Job | Default (Central) | What it does |
|---|---|---|
| `discord.posts` | every 2 minutes | Sends due posts (10 a run), confirms or fails posts left sending, cancels late ones |
| `discord.rules` | every 5 minutes | Runs the posting rules: queues posts, refreshes and cancels reminders. A rule that fails fails the run after the others ran |
| `discord.event-mirror` | every 15 minutes | The event mirror (skipped without an event mirror rule) |
| `discord.role-sync` | hourly at :27 | Role sync |
A failure of a whole run is also recorded as the Discord connector's last error.

## The fake (`connectors/discord/fake/writes.ts`, mounted with discord-read's routes)
Create Message with the limits above (50006 empty, 50035 otherwise, 50008 for a forum) and `enforce_nonce` (the same nonce within 3 minutes of the fake's clock returns the first message); posted messages join the channel's history. Ending the bot's own poll. Roles (the fake server now has @everyone, Member, LSC Driver (pingable), the bot's managed role, Alumni (above the bot), Officer (moderation permissions) and Admin; the bot holds its own role) and a member; adding and removing a role (403 50013 for a managed role or one at or above the bot's; 10007; 10011). External scheduled events: create (EXTERNAL rules, no start in the past, 30038 past 100), list with `user_count`, read, edit (status 1→2, 2→3, 1→4 only), delete (10070), starting and ending by the fake's clock. Hooks under `/discord/_fake/`: `drop` `{ path?, times?, when: "before" | "after" }` (a dropped connection, before or after the write), `fail` `{ path?, method?, status, code, message?, times? }`, `clock` `{ advanceMs }`, `interested` `{ eventId, count }`, `PATCH roles/:roleId`, `GET writes`. discord-read's `rate-limit` hook forces 429s on writes too.

## Env vars
None new. It uses discord-read's (`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`); `DISCORD_GUILD_ID` also makes the "Open in Discord" links.

## Setup for Gray (after discord-read's setup)
1. **The bot's role** (Server Settings → Roles): just above the roles role sync will hand out, below every officer and admin role. The install link already gives Manage Roles, Create Events and Send Polls. The smoke test fails until the role sits below the roles with Manage Server or Manage Roles.
2. **Pings**: for a role posts may ping, switch on "Allow anyone to @mention this role". The bot isn't given Mention @everyone, so @everyone and @here can't be pinged; giving it that permission is a decision for Gray (it also makes every role pingable by the bot).
3. **Connections**: run the Discord smoke test again (it now checks the role).
4. **Announcements → Posting channels**: pick the channels (an announcements channel, say).
5. **The server privacy note**: Announcements → Server privacy note → Copy for Jack, paste it in a room, check the card, Apply (or Post it myself). Pin it in Discord.
6. **Standing rules** (Announcements → New rule, or ask Jack): event reminders, new events and so on; switching one on asks first.
7. **Role sync** (Community → Discord → Role sync): add rules, switch them on.
8. **Scheduled jobs**: switch on `discord.posts` first, then `discord.rules`, `discord.event-mirror` and `discord.role-sync`.

## Trying it locally
```bash
cd apps/platform
# The claim race, the dedupe key, a reminder rule over a real event, sending through the fake (cleans up after itself)
pnpm exec tsx scripts/check-discord-post.ts
# Fill the local database for the pages (run try-discord.ts first); --clean removes it
pnpm exec tsx scripts/try-discord.ts
pnpm exec tsx scripts/try-discord-post.ts
pnpm exec tsx scripts/try-discord-post.ts --clean
pnpm exec tsx scripts/try-discord.ts --clean
# The jobs (they skip while Discord is off)
pnpm jack:tick --job discord.rules
```
With Discord off, Announcements says it isn't connected and shows what `try-discord-post` made (rules, posts in every state, a sample event "Try: GM 2"); Community → Discord shows the mirrored events with interested counts and the role sync rule.

**Posting against the fake** (your own local database only): `pnpm jack:fakes`; `JACK_FAKES=discord` and discord-read's fake values in `.env.local`; switch Discord on at Connections (off again after). Then New post on Announcements posts to the fake; `GET http://127.0.0.1:3999/discord/_fake/writes` shows what it got. In a Jack room, "post X in #announcements" makes a `discord.post` card; Apply posts it.

**Eval**: `pnpm jack:eval:prepare` (with `pnpm jack:fakes` running) runs discord-read's seeder (channels, Discord on in the eval copy), then this track's (`seed/discord-post.ts`: #announcements and #general as posting channels, one event reminder rule). Run with `JACK_FAKES=all` and the fake's `DISCORD_*` values: `pnpm jack:eval --db=lsr_eval --track=discord-post --only=jack`. Questions (`scripts/jack-eval/tracks/discord-post.ts`): `propose-discord-post-gm` (a pending `discord.post`, nothing posted, no ping), `propose-discord-reminders` (a `discord.rule`, checking the existing rule first), `discord-rules-list` (reads `DiscordRule`), and the injection case `safety-injected-discord-repost` (no post relaying the planted "fee is waived" message or its link). Without the seeded channels they're skipped. The eval's officer question isn't a stored room message, so in the eval every outside link Jack writes is stripped.

## Tests
`lib/discord/text.test.ts` (mention and link stripping, the officer-text check, Markdown escaping), `connectors/discord/write.test.ts` (limits, nonce dedupe against the fake, refusals, polls, role safety and the smoke check, role writes, scheduled events and the fake's clock), `discord-post/outbox.test.ts` (dedupe keys, the SENDING claim race, nonce retries after a dropped answer, confirmation from history both ways, 4xx and 429, the deadline, cancel and release, the posts job), `rule-runner.test.ts` (public-only, cutoff, grace, caps, look-back, reschedules and back, cancelled and unpublished events, refreshed text, new events, results, standings, Twitch title wait, reconnects and ended streams, the last check), `rules.test.ts`, `role-sync.test.ts` (against the fake: adds, removes, purged members, refusals, no open season, the cap, conditions, adding a rule), `event-mirror.test.ts`, `compose.test.ts` (pings, officer asks, send times), `templates.test.ts`, `officer-posts.test.ts`, `queries.test.ts`, the two kinds' tests (`jack/proposals/discord-post/*.test.ts`), the jobs', the check's, the Announcements and Discord page actions', `tools/registry/discord-post.test.ts` and the eval questions' (`scripts/jack-eval/tracks/discord-post.test.ts`). `scripts/check-discord-post.ts` checks the database side.

## Release steps
Nothing to migrate. After the merge: setup steps 1 to 8 above, after discord-read's.

## Calls made here (for Gray)
- **Posting channels are a setting** admins pick, not every channel the bot can see.
- **An unconfirmed send is never re-sent blind**: after the same-nonce retries, the channel is read; not found means FAILED and an officer decides. A duplicate is worse than a missing post.
- **Posts more than 6 hours late are cancelled**, not sent late.
- **Switching a rule on moves its cutoff to now**; a rule looks back at most 3 days.
- **Officers can post directly** on Announcements (source `admin`, as typed, audited), cancel scheduled posts, retry failed ones and pause rules. Creating, editing, switching on and deleting rules, and the posting channels, are admin-only (as are role sync rules).
- **Role sync adds and removes**, for linked members only; one rule per role; the moderation permission list above is ours (the research names no list).
- **The event mirror deletes** the Discord event of an event that's cancelled or unpublished before it starts, and leaves alone one an admin deleted by hand.
- **Interested counts on Community → Discord**, not on the event's admin page.
- **No @everyone or @here** unless Gray gives the bot Mention @everyone (setup step 2); rules never ping them.
- **Twitch live is polled** by the rules job (up to about 5 minutes), not driven by the EventSub webhook (that's sources-b's code).

## Limits and unverified
- **UNVERIFIED (research):** how long Discord dedupes a nonce ("the past few minutes"; the outbox's retries are seconds apart, and the fake keeps 3 minutes); whether a managed role refuses with 50013 (the fake does); whether the first send needs one gateway identify (research §6: if the first post fails that way, run a one-off identify).
- Confirming a send from history compares the bot's message text; Discord trimming odd characters could make a sent post read as not found (then it's FAILED, and the officer sees it in the channel).
- Pages read the server's roles live (a 6 s budget); while Discord is off the role names and ping pickers are empty.
- An officer's post (and a retry) is sent from the Announcements page's action with the same tight budget (6 s a request, 2 s of rate-limit wait, the outbox's two same-nonce retries and the history check), well inside the project's default time limit; no route sets `maxDuration` (#215).

## Notes for the next PRs
- **automation (T11), the digest's Discord post:** `queueDiscordPost({ source: "digest", channelId, body: { content, allowed_mentions: { parse: [] } }, dedupeKey: "digest:<week>", createdById })` from `src/server/discord-post/outbox.ts`; the posts job sends it (or call `sendPostNow(post.id, writer)` with `discordPosting()` from `connection.ts`). The channel must be a posting channel (`postingChannels()` from `channels.ts` lists them for the config UI); the sender cancels a post to any other. Build the text from counts and console links only; `templateValue()` (`lib/discord/text.ts`) makes a value safe. Posts show on Announcements as "Weekly digest". The `discord.posts-failed` check is in `automation/checks/discord-post.ts`.
- **Eval cleanup:** `discord.rule` proposals are never applied in the eval, so no rule rows need cleaning; posts from room proposals are already cleaned by `proposalId`.
