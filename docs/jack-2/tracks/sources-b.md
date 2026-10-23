Docs and env notes for the sources-b track (T5: Twitch and Instagram insights); folded into docs/jack.md at the end.

Design §12.2 and §12.6, §13 (Content → Streams, Content → Instagram, Overview) and §7.1 (`twitch_stats`, `instagram_insights`). Research: `research/twitch.md`, `research/instagram.md`. Code paths are relative to `apps/platform/`.

**Database change (additive):** one new table, `TwitchEventSubMessage` (migration `20261024010000_jack2_twitch_eventsub`). G1's schema had nowhere to remember which EventSub messages were handled, and the webhook must skip a resend (Twitch resends with the same message id). It holds message ids only, is pruned after 2 days, and isn't personal data (no RLS; `jack_readonly`'s default grant covers it).

## What's where

| Piece | Where |
|---|---|
| Twitch HTTP client (Helix and OAuth) | `src/server/connectors/twitch/client.ts` |
| Twitch tokens in SystemSetting `twitch` (row lock) | `src/server/connectors/twitch/tokens.ts` |
| Twitch connector and the channel client | `src/server/connectors/twitch/connector.ts` |
| A stream's life (open, samples, close, VODs) and reads for other tracks | `src/server/connectors/twitch/streams.ts` |
| EventSub signature, window and message shapes | `src/server/connectors/twitch/eventsub.ts` |
| What the webhook does | `src/server/connectors/twitch/webhook.ts`, route `src/app/api/webhooks/twitch/route.ts` |
| Connect the club account (OAuth) | `src/server/connectors/twitch/oauth.ts`, routes `src/app/api/admin/twitch/connect` and `/callback` |
| Twitch jobs | `src/server/connectors/twitch/sync.ts`, registered in `src/server/scheduler/jobs/sources-b.ts` |
| EventSub setup (script and its logic) | `scripts/twitch-eventsub.ts`, `src/server/connectors/twitch/eventsub-setup.ts` |
| Twitch fake (OAuth, Helix, EventSub sender) | `src/server/connectors/twitch/fake/handlers.ts` |
| Instagram Graph client for one token | `src/server/connectors/instagram/graph.ts` |
| Insights calls | `src/server/connectors/instagram/insights.ts` |
| Instagram insights connector | `src/server/connectors/instagram/connector.ts` |
| Instagram jobs | `src/server/connectors/instagram/sync.ts` |
| Instagram fake (feed sync and insights) | `src/server/connectors/instagram/fake/handlers.ts` |
| Reads for pages and tools | `src/server/queries/twitch.ts`, `src/server/queries/instagram-insights.ts` |
| Content → Streams | `src/app/admin/streams/` |
| Overview card (streams) | `src/app/admin/_overview/cards/sources-b.tsx` |
| Instagram page's Insights section | `src/app/admin/instagram/_sections/sources-b.tsx` |
| Digest checks | `src/server/automation/checks/sources-b.ts` |
| Jack tools | `src/server/jack/tools/twitch-stats.ts`, `instagram-insights.ts` (registry slot `tools/registry/sources-b.ts`) |
| Prompt section and schema notes | `src/server/jack/prompt-sections/sources-b.ts`, `tools/schema-notes-slots/sources-b.ts` |
| Eval questions and fake data | `scripts/jack-eval/tracks/sources-b.ts`, `scripts/jack-eval/seed/sources-b.ts` |
| DB check | `scripts/check-jack-sources-b.ts` |

## Twitch

### Tokens and the club account
- **App token** (client credentials) for everything public: live status, channel info, VODs, EventSub. It's cached in SystemSetting `twitch` and minted again near its end or when Twitch answers 401.
- **The club account's grant**: an admin connects it once on Content → Streams, signed in to Twitch as the club account. It asks only for `moderator:read:followers` (the follower total; it also makes `stream.online` cost 0). The access token (about 4 hours) and its refresh token go to SystemSetting `twitch`, never anywhere else. Twitch may rotate the refresh token on every refresh, and one refresh token backs at most 50 live access tokens, so every write to the setting happens under a row lock (`SELECT … FOR UPDATE`), and a refresh re-reads the row first: callers that waited use the token the refresh before them stored.
- **When Twitch refuses the refresh token** (a password change, the app disconnected): the grant is kept but marked `reconnect`; the follower count stops, the digest check flags it, and Content → Streams asks an admin to reconnect. A Twitch error that's only temporary (a 503) marks nothing.
- **Connect flow** (`/api/admin/twitch/connect` → Twitch → `/api/admin/twitch/callback`), admins only:
  - the state sent to Twitch is random; a 10-minute httpOnly, SameSite=Lax cookie (path `/api/admin/twitch`) holds it with an expiry and a MAC over the state, the admin's user id and the expiry (keyed by `TWITCH_CLIENT_SECRET`). The callback takes a code only from the same browser and the same admin;
  - `force_verify=true` makes Twitch show which account is signed in;
  - the callback keeps the grant only if `/validate` says it's `TWITCH_BROADCASTER_ID` with the scope; anything else (someone's personal account) is revoked at once;
  - it's audited (`CONNECT`, entity `CONNECTOR`, id `twitch`; the account name, never a token). Disconnect (Content → Streams) revokes the token at Twitch and forgets the grant (`DISCONNECT`, audited).
  - The page it returns to gets only a result code (`?twitch=connected|denied|wrong-account|missing-scope|expired|not-configured|failed`).
- **Hourly validation**, which Twitch requires of apps that keep a user session: the token check job.

### EventSub webhook (`POST /api/webhooks/twitch`)
- Reads the raw body first; the signature is `sha256=` + HMAC-SHA256 over message id + timestamp + raw body with `TWITCH_EVENTSUB_SECRET`, compared in constant time. Messages more than 10 minutes old (or ahead) are refused. Every refusal is a 403 with no body, and without the secret nothing is accepted.
- The challenge is answered with the raw string as `text/plain`, also while the connector is switched off (setup comes first), and only for the club's channel.
- Each message id is handled once (`TwitchEventSubMessage`, insert-if-new). A resend gets 204 and nothing else. If handling fails, the id is released and the route answers 500, so Twitch's resend is handled.
- `stream.online` (type `live` only; reruns and premieres are ignored) opens the stream's row; the title and category are read from Get Channel Information after the response (`after()`), since the event doesn't carry them and Twitch wants an answer within seconds. `stream.offline` closes the stream it names, at the message's time, and nothing else (a late offline for a stream that's already closed must not close the one that replaced it); only when it names none does it close every stream open when it was sent.
- Notifications are ignored while the connector is switched off.
- **A revocation** (`notification_failures_exceeded`, `authorization_revoked`, …) is kept in SystemSetting `twitch` as `eventsubRevoked` (type, Twitch's reason, time), under the setting's row lock, not as the connector's last error: every sync stamps the connector, so an error would read as fixed within the hour. Content → Streams shows a notice with the command to run, System → Connections a "Webhooks" detail line, and the `twitch.attention` digest check an item, until Twitch delivers to that type again: its challenge (the setup script subscribing again) or a notification clears it. Going live is still noticed meanwhile, by the every-minute check.

### Jobs (all off until an admin turns them on)
| Kind | Schedule (Central) | What it does |
|---|---|---|
| `twitch.live` | every minute | Get Streams. Live: makes sure the stream has a row (a missed webhook), keeps its title, saves the minute's viewer count, peak and running average. Not live while a stream is open: closes it after 3 misses in a row (Get Streams lags and flaps; one miss proves nothing), at its last sample. A stream with no samples that went live less than 10 minutes ago isn't counted as missed (Get Streams can leave a new stream out for minutes). Only `stream.offline` is final: a stream this check closed is reopened if Get Streams lists it again (it remembers the last 5 it closed in its cursor). |
| `twitch.daily` | 5:40 AM | Every past broadcast's VOD views (Twitch deletes VODs), adding a closed row for broadcasts with none (no viewer counts there), except one that may still be live (Get Streams lists it, or its archive reaches into the last 10 minutes; the live check opens those), and the day's follower total (TwitchChannelDaily, Central date). |
| `twitch.token-check` | :05 every hour | Validates the app token and the club account's token (refreshing it if Twitch no longer accepts it), and prunes EventSub ids older than 2 days. |

Each returns `skipped` while the connector has no client (switched off, env missing, or the club account not connected), and records failures on the connector (redacted). A run that wrote nothing (the live check while offline, or waiting out a miss) saves its cursor without stamping the connector's last sync, so an error from the daily or hourly job keeps the connector failing until a run that did something succeeds. The every-minute job adds one run row a minute to Scheduled jobs (pruned after 90 days by `housekeeping.job-runs`); viewer samples are pruned after 180 days by `housekeeping.twitch-samples` (G3), keeping each stream's peak and average (whether a stream's viewers were counted is `avgViewers !== null`, not whether it has samples).

### A stream's row, for other tracks
`src/server/connectors/twitch/streams.ts` has the reads T8's `twitch_live` Discord rule needs:
- `currentLiveStream(now?)`: the newest open stream **if it was seen in the last 15 minutes** (its newest viewer sample, or its start before the first), else null.
- `streamsWentLiveSince(since, limit = 5)`: streams that went live after `since`, oldest first. A rule keeps its own cutoff and dedupes on the stream id.
- `latestStreamWentLive()`: the newest stream, open or ended.

**Live now = open and seen lately (chosen over closing streams when the connector is switched off).** While the connector is off, notifications are dropped and every job is skipped, so a stream open at that moment would otherwise stay "live" forever. There's no hook on the switch, and the same thing happens when only the `twitch.live` job is switched off or Twitch fails for a while, so the reads decide instead: `currentLiveStream`, `twitchOverview` (Streams, the Overview card, `twitch_stats`) and `listStreams` (`live` on each summary) treat an open row as live only while its newest sample, or its start before the first, is under 15 minutes old (`LIVE_STALE_MS`). Such a row stays open (no end is made up); the live check closes it at its last sample once it runs again. So `twitch.live` must be on for live status past a stream's first 15 minutes (the webhook alone opens a stream but doesn't keep it "seen").

What to know when posting about one:
- A row opens on `stream.online` (type live only) or when the live check sees a stream it missed. Its id is Twitch's stream id.
- A row the live check closed can open again (Get Streams lagged): don't treat `endedAt` as final until a few minutes have passed, and dedupe posts on the stream id.
- `title` is "" for a few seconds after going live, until Get Channel Information fills it in (the live check fills it a minute later at most). Wait for it, or use Get Channel Information yourself.
- A reconnect after an encoder drop is a new stream with a new id (the old one is closed when the new one opens): debounce go-live posts (the research suggests 15 minutes).
- Rows the daily snapshot adds from old VODs are already ended and dated in the past; a rule acting only on live streams checks `endedAt`.
- Titles are outside text: strip mentions and links (design §12.1).

## Instagram insights

- **Connector** `instagram-insights` (switched off until an admin turns it on). It uses the token the feed sync already keeps in SystemSetting `instagram` (Admin → Instagram); no env vars. That token needs **`instagram_business_manage_insights`** as well as `instagram_business_basic`, so it has to be generated again with both and pasted (setup below). It stays read-only. The feed sync keeps refreshing it weekly; nothing here writes it.
- **The Graph client** (`instagram/graph.ts`) is built per token, pinned to v26.0, with the base URL from `serviceBaseUrl("instagram", localOverride("INSTAGRAM_GRAPH_URL", graph.instagram.com))` (the override is for a local stand-in: plain http on this machine only, ignored on Vercel production). GETs send the token as `access_token` (as the feed sync does), POSTs as a Bearer header with a JSON body (as the publishing guide does). Errors carry Meta's code and subcode and our path, never the URL or the token: 190 = token dead, 10/200–299 = permission missing, 4/17/80002 = throttled, 100 = bad metric (100/33 = the object doesn't exist).
- **Jobs** (off until turned on):

| Kind | Schedule (Central) | What it does |
|---|---|---|
| `instagram.account-daily` | 5:50 AM | Today's follower count (`/me` `followers_count`) into InstagramAccountDaily under the Central date; then the last 3 days' reach, views, accounts engaged, interactions (one `total_value` call per day), follows and unfollows (`follows_and_unfollows` broken down by `follow_type`, FOLLOWER = follows, NON_FOLLOWER = unfollows) on the rows that exist. Instagram is up to 2 days late, so each day is read 3 times. |
| `instagram.post-insights` | :25 every hour | Each due post's lifetime reach, likes, comments, saved, shares and views on InstagramPost (+ `insightsAt`): hourly in a post's first week, daily up to 30 days, monthly after; never-read posts first; 30 posts a run. A post Instagram has no numbers for (deleted: 100/33; too few viewers: 10 "Not enough viewers") is marked read and skipped. |

- **Days before the first snapshot stay empty.** A row's `followers` is that day's snapshot (the column isn't nullable), so the job never makes up a past day's follower count; a day's numbers come in the day after its first snapshot. Account numbers older than 90 days can't be fetched anyway.
- When Instagram refuses a set of metrics (error 100), each is asked for alone and the refused ones stay null (never 0). An empty `data` list is null too.
- A failure is explained on the connector ("doesn't have the insights permission: generate it again…", "expired or was revoked: paste a new token…") and in the run log.
- **For T9b (`instagram-publish`):** build another client with `instagramGraph(publishToken)` (its `post()` sends JSON with a Bearer header) and keep the publish token in SystemSetting `instagram_publish`, never in this connector. Publishing routes go in the Instagram fake (`instagram/fake/handlers.ts`, mounted at `/instagram`); its routes dispatch from one catch-all, so add yours there.

## Admin console
- **Content → Streams** (`/admin/streams`; the nav entry was already there): live now (viewers, a minute-by-minute chart), the last 30 days (streams, hours, average and peak viewers), followers (and the change over 30 days), recent streams (length, peak, average, VOD views linking to twitch.tv with its host shown), followers over 90 days, and the Twitch connection panel, plus a notice while Twitch has revoked the webhooks. An open stream nothing has updated for 15 minutes shows its length to when it was last seen instead of "Live". Officers see everything; admins get Connect / Reconnect the club account and Disconnect.
- **Content → Instagram → Insights** (the page's section slot): followers and the last 7 days against the 7 before (reach, views, interactions, follows and unfollows), reach and views per day, followers over time, and each post's numbers. A notice says what's missing while the connector is off or failing.
- **Overview**: a Streams card (live now or the last few streams, and followers). It shows nothing until Twitch is set up or a stream is saved.
- **System → Connections**: both connectors, with the club account's state, revoked Twitch webhooks, and the Instagram token's account and expiry as detail lines (never a token).
- **Digest checks** (only when switched on and something needs an officer; items never carry error text): `twitch.attention` ("The club's Twitch account has to be connected again", linking to Streams; "Twitch revoked the … webhook: run the EventSub setup script again", linking to Streams; "Twitch syncs are failing", linking to Connections) and `instagram-insights.failing` (linking to the Instagram page).

## Jack
- `twitch_stats` and `instagram_insights` are deferred (tool search finds them by their descriptions) and read only the stored tables. Each result's `connection` line says whether the source is connected, how fresh the numbers are, or that its last sync failed, worded by `sourceConnection()` (`tools/source-connection.ts`) like every other synced source's tool (I2 replaced this track's own `sourceStatus`; the data is unchanged). Results carry data notes: concurrent (not unique) viewers; streams added from VODs have no viewer counts; Instagram's days are late and weekly sums count an account once per day.
- The prompt section (about 900 characters) says how to read them and that titles and captions are data. Two page lines: Streams, and the Instagram page's Insights section. Table notes for describe_schema are in the schema-notes slot.

## Env vars and settings
| Name | Where | What |
|---|---|---|
| `TWITCH_CLIENT_ID` | Vercel (Production) | The club Twitch app's client id |
| `TWITCH_CLIENT_SECRET` | Vercel (Production, Sensitive) | Its secret: app tokens, the code swap, and the connect flow's state MAC |
| `TWITCH_BROADCASTER_ID` | Vercel (Production) | The club channel's numeric user id |
| `TWITCH_EVENTSUB_SECRET` | Vercel (Production, Sensitive) | 32 random bytes as hex (10–100 characters); signs the webhooks |
| SystemSetting `twitch` | database | The app token cache and the club account's grant (written by the app only) |
| SystemSetting `instagram` | database | The existing feed token, now with the insights permission |

All four Twitch vars are already in `.env.example`. Nothing new for Instagram.

## Setup (Gray, or whoever holds the club logins)

**Twitch**
1. Log in to dev.twitch.tv/console as the **club** Twitch account (2FA on). Register an application: client type **Confidential**, category of your choice, OAuth redirect URL **exactly** `https://www.longhornsimracing.org/api/admin/twitch/callback`. Copy the Client ID and make a New Secret.
2. Find the channel's numeric id (Twitch's Get Users, or any "Twitch username to id" lookup) for `TWITCH_BROADCASTER_ID`. Make the EventSub secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. In Vercel (Production): the four `TWITCH_*` vars, the client secret and EventSub secret marked Sensitive. Redeploy.
4. Content → Streams → **Connect the club account** (an admin), signed in to Twitch as the club account (Twitch shows which account; sign out of a personal one first).
5. Subscribe the webhooks, from a machine with the same four env vars (e.g. `vercel env pull`): `pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts` shows the plan; add `--apply` to create `stream.online` and `stream.offline`. It waits for Twitch's challenge and says when both are enabled. Run it again whenever Content → Streams says Twitch revoked them; the notice goes away when Twitch's new challenge reaches the site.
6. System → Connections: run Twitch's smoke test ("Read @…, offline; club account @… OK, N followers"), then switch it on. Then on Scheduled jobs turn on `twitch.live`, `twitch.daily` and `twitch.token-check`.
7. Before ever deleting the Twitch app: `scripts/twitch-eventsub.ts --remove --apply` (subscriptions keep firing otherwise).

**Instagram insights**
1. In the Meta app's Instagram use case (API setup with Instagram business login), give the token both `instagram_business_basic` and `instagram_business_manage_insights` (still read-only; no publishing, comments or messages), generate it, and paste it in Admin → Instagram (Replace token). The feed keeps working with it.
2. System → Connections: run Instagram insights' smoke test ("Read @…: N followers; yesterday's reach …"; a missing permission fails with code 10), then switch it on. On Scheduled jobs turn on `instagram.account-daily` and `instagram.post-insights`.
3. The account needs 100+ followers for follows and unfollows (Instagram's rule).

## Release steps
1. The migration `20261024010000_jack2_twitch_eventsub` goes to production with the other 2.0 migrations, before the code (additive).
2. After the merge: the setup above. Both connectors and their jobs ship switched off; turn each on after its smoke test.
3. Watch the first `twitch.live` runs and a real go-live: the stream should open from the webhook (Content → Streams shows it live within seconds, its title a few seconds later).

## Try it locally (fakes only, nothing real)
1. In `apps/platform/.env.local`: `JACK_FAKES=twitch,instagram` (or `all`), `TWITCH_CLIENT_ID=fake-twitch-client-id`, `TWITCH_CLIENT_SECRET=fake-twitch-client-secret`, `TWITCH_BROADCASTER_ID=141981764`, `TWITCH_EVENTSUB_SECRET=fake-eventsub-secret-0123456789abcdef` (the fake's values, `TWITCH_FAKE` in `twitch/fake/handlers.ts`). Don't also set `INSTAGRAM_GRAPH_URL`: JACK_FAKES already points the feed sync at the fake.
2. `pnpm jack:fakes` and `pnpm dev`.
3. Content → Streams → Connect the club account: the fake's consent page signs in as the club right away and comes back "Connected". (`POST http://127.0.0.1:3999/twitch/_fake/authorize` with `{"as":"other"}` or `{"deny":true}` tries the refusals.)
4. `pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts --local --callback=http://localhost:3000/api/webhooks/twitch --apply`: the fake sends each subscription a signed challenge and both come back enabled.
5. Switch Twitch on (Connections), then go live: `curl -X POST http://127.0.0.1:3999/twitch/_fake/live -d '{"title":"Practice","viewers":20}'`. The webhook opens the stream; `pnpm --filter @lsr/platform jack:tick --job twitch.live` samples it; `/_fake/offline` ends it (its VOD appears); `jack:tick --job twitch.daily` reads VODs and followers. Knobs: `/_fake/eventsub/send` (`{"type":"stream.online","duplicate":true}`, `"stale":true`, `"badSignature":true`), `/_fake/eventsub/revoke`, `/_fake/streams` (`{"lag":3}`, `{"flap":true}`), `/_fake/fail` (`{"status":429}`), `/_fake/tokens/expire` (`{"kind":"user","refresh":true}` acts out a password change), `/_fake/followers`, `/_fake/videos`; `GET /_fake/state`.
6. Instagram: paste `IGfake-read-insights-token` in Admin → Instagram (`IGfake-read-basic-token` is today's basic-only token, which the insights calls refuse with code 10). The feed sync reads the fake's 10 posts (images won't copy without Cloudinary keys). Switch Instagram insights on, then `jack:tick --job instagram.account-daily` and `--job instagram.post-insights`. Knobs: `POST /instagram/_fake/state` with `{"expire":true}`, `{"passwordChanged":true}`, `{"throttle":2}`, `{"followers":80}`, `{"deleteMedia":["…"]}`, `{"fewViewers":["…"]}`.
7. To see the pages with history: `pnpm jack:eval:prepare --db=lsr_eval --track=sources-b` (with `pnpm jack:fakes` running) fills an eval copy, or run the same seeders (`scripts/jack-eval/seed/sources-b.ts`) against a local database you can throw away.

## Tests and checks
- Unit tests (fakes through `mountFakes`, Prisma mocked or the in-memory tables in `connectors/sources-b-test-db.ts`): `connectors/twitch/*.test.ts` (client, tokens and the lock's re-read, jobs, EventSub signatures against a vector computed apart from the code, setup planning), `connectors/instagram/*.test.ts`, `connectors/sources-b-connectors.test.ts` (configured, smoke tests, details), `app/api/webhooks/twitch/route.test.ts` (every refusal, dedupe, release on failure, the fake's sender end to end), `app/api/admin/twitch/callback/route.test.ts` (state binding, wrong account revoked, denial), `jack/tools/sources-b.test.ts`, `automation/checks/sources-b.test.ts`, `queries/sources-b.test.ts`, `lib/instagram.test.ts`.
- `pnpm --filter @lsr/platform exec tsx scripts/check-jack-sources-b.ts` (local database only): EventSub dedupe, a stream's life (live only while seen lately, still counted after its samples are pruned), five refreshes at once under the row lock make one, revoked webhooks kept and cleared, Central dates on the daily tables, and the reads' SQL (NULLs last, case-insensitive search). It writes only rows it creates and deletes again: 1999 dates, throwaway ids, the Twitch setting under a throwaway key (the functions in `tokens.ts` take the key for this), and one throwaway Instagram post. It never runs a whole job (that would stamp the connectors and read every due post): it calls `snapshotInstagramAccount` and `readPostInsights` on its own rows.

## Choices made here
- **A table for EventSub message ids** (the one schema change), rather than keeping ids in the connector's cursor or a setting.
- **The club account is required** for the Twitch connector to count as set up (`missingSettings: ["twitch"]`), so the Connections page lists it as a setup step; without it there's no follower total, and `stream.online` would cost 1.
- **Notifications are dropped while the connector is off** (and not marked handled); challenges and revocations are processed regardless.
- **The live check is one every-minute job** that polls whether or not a stream is open (one Helix call; it's also the backstop for a missed webhook), rather than a 10-minute offline cadence: the scheduler calls the site every minute for it anyway.
- **Past broadcasts found only through VODs** become closed TwitchStream rows with no samples; pages and tools say their viewers weren't counted instead of showing 0. "Counted" is the stream's own `avgViewers` (set from its first sample), so streams older than the 180-day sample pruning keep their numbers.
- **Webhook health lives in the Twitch setting**, not in the connector's last error, which any later sync hides.
- **The live check's cursor** holds misses in a row and the ids it closed itself (to reopen); it's written without stamping the connector's last sync when the run wrote nothing.
- **The connect callback** is `/api/admin/twitch/callback` (the research suggested `/api/twitch/oauth/callback`); it's under the admin API like the other admin routes.
- **The digest check for a refused Twitch token links to Content → Streams**, where the Reconnect button is (failing syncs link to Connections).
- **The feed sync's client** (`lib/instagram.ts`) now joins its base URL instead of resolving the path against it (a stand-in mounted under a path, like the fake's `/instagram`, used to lose its path), and goes through `serviceBaseUrl`, so `JACK_FAKES=instagram` points it at the fake. Against the real API nothing changes.

## Not verified live (check with the smoke tests)
- Twitch: whether an app token alone would get the follower total (we use the user token, so it doesn't matter); our real rate limit; Get Streams' lag (allowed for: 10 minutes at the start, reopening after); whether `stream.offline` carries the stream id (handled either way); that a live broadcast's archive VOD is listed while live with a growing duration (the daily snapshot skips it either way while Get Streams lists the stream).
- Instagram: that graph.instagram.com accepts `metric_type=total_value` with since/until for one Central day (the docs say so), that `follows_and_unfollows`' breakdown is FOLLOWER/NON_FOLLOWER for follows/unfollows, and the metric set for reels (`saved`, `shares`, `views` are documented for feed and reels). A refused metric falls back to one at a time and stays null.
