# Twitch: live status, VODs, followers and go-live posts for Jack 2.0

Researched 2026-10-22 from dev.twitch.tv (API reference, authentication, EventSub, Twitch CLI pages) and a few Twitch developer forum threads. **UNVERIFIED** marks claims the official docs don't state.

**Recommendation:**
- One Twitch app, registered under the **club's** Twitch account. Use an **app access token** (client credentials) for everything public, and **EventSub webhooks** for `stream.online` / `stream.offline`.
- Have the club account authorize the app **once** with only `moderator:read:followers`. That gives a documented way to read the follower total, brings the `stream.online` cost to 0, and lets us store stats beyond Twitch's 24-hour cache rule (section 6).
- Snapshot everything into our own tables (stream samples, VODs, follower totals). VODs expire on Twitch, and Jack should read our tables, not Twitch.

## 1. What we'd use it for

The club streams on Twitch. Jack 2.0 should answer questions like "are we live?", "how did last week's stream do?" and "how many followers do we have?". The go-live event should also trigger a Discord post. Everything here is read-only and moves no money. It also needs no daemon:
- A Vercel route receives signed EventSub webhooks (`stream.online` → Discord go-live post, `stream.offline` → close the session).
- Supabase `pg_cron` + `pg_net` call a Vercel cron route every minute while live, to sample `viewer_count`. The same route runs daily to snapshot VOD `view_count` and the follower total.
- Jack reads the resulting tables through `jack_readonly`.

## 2. Auth and setup

**Register the app (once, by an officer who holds the club Twitch login):**
1. Log in to dev.twitch.tv/console as the **club** account. **2FA must be on**, or the console won't let you register.
2. Go to Applications → Register Your Application. Pick a unique name, add the OAuth redirect URL `https://<prod-host>/api/twitch/oauth/callback` (and `http://localhost:3000` for the one-off manual flow), choose a category, and set the client type to **Confidential**.
3. Under Manage, copy the **Client ID** (public) and click **New Secret**. Generating a new secret invalidates the old one.
4. Don't reuse this client ID in other apps; Twitch may suspend client IDs that are shared. Local dev uses the fake (section 7), or a separate dev app.

**Two token types:**

| | App access token | User access token (club account) |
|---|---|---|
| Flow | Client credentials: `POST id.twitch.tv/oauth2/token` with `grant_type=client_credentials` | Authorization code, done **once**: `/oauth2/authorize?response_type=code&scope=moderator:read:followers&state=…`, then `/oauth2/token` |
| Lifetime | The example shows `expires_in: 5011271` (about 58 days). The exact value isn't documented. | Examples show about 14–15.5k s (about 4 h). |
| Refresh | **Cannot be refreshed.** Mint a new one (on a 401 or near expiry). | `grant_type=refresh_token`. Confidential-client refresh tokens don't expire, but they **may rotate**, so store the new one each time. A refresh token can back at most 50 live access tokens. |
| Invalidated by | Expiry or revocation. Whether **New Secret** kills existing app tokens is **UNVERIFIED**: the docs only say it invalidates the old secret, and a forum reply says existing tokens survive. Mint a fresh app token after any secret rotation anyway. | The user changing their password, the user disconnecting the app, or Twitch revoking it |

**Which token each call needs:**

| Call | Token |
|---|---|
| Get Users, Get Streams, Get Channel Information, Get Videos | App **or** user token. Use app. |
| Get Channel Followers | Docs: a **user** token with `moderator:read:followers` whose user is the broadcaster or a mod; `data` + `total`. Without the scope or role, "only the total follower count" is returned. Using an **app** token for the total alone is community-reported ("any token will suffice", BarryCarlyon, forum, 2023-10-04), not in the docs: **UNVERIFIED**. |
| Create / Get / Delete EventSub subscription (webhook transport) | **App token only.** A user token returns 401. |
| `GET id.twitch.tv/oauth2/validate` | Any token. Twitch **requires** apps that keep an OAuth session to validate at start and **hourly**, and it audits this. |

**Narrowest scope:** only `moderator:read:followers`. No scope is needed for streams, videos, channel info or `stream.online` / `stream.offline` ("No authorization required").

**Storage:** keep the user refresh token and the cached app token in a DB table (it rotates, and serverless has no memory). Keep that table **out of the `jack_readonly` grants**: only secrets stay revoked. Refresh in one place (a single row lock), because concurrent refreshes can hit the 50-token cap.

**Env vars:** `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_ID` (string, from Get Users once), `TWITCH_EVENTSUB_SECRET` (32 random bytes as hex, 64 chars; it must be 10–100 ASCII chars), `TWITCH_API_BASE` (default `https://api.twitch.tv/helix`), `TWITCH_AUTH_BASE` (default `https://id.twitch.tv/oauth2`). `CRON_SECRET` already exists for the pg_net → route call. All are Production only in Vercel.

## 3. Endpoints we need

**Every Helix call:** send `Authorization: Bearer <token>` and `Client-Id: <client id>`; a client-ID mismatch returns 401.
- Multi-value params are **repeated** (`id=1&id=2`), not comma-separated.
- IDs are opaque strings.
- Pagination: `first` (1–100, default 20) and an `after`/`before` cursor. `pagination: {}` means the last page.
- Error bodies look like `{"error":"Bad Request","status":400,"message":"…"}`. The guide doesn't specify the shape, but the API reference shows it on a Helix endpoint (Ban User, example response 3) as well as in the OAuth docs. Don't key on the message strings.
- On a 503, retry once.

### 3a. Tokens: `POST https://id.twitch.tv/oauth2/token` (form-encoded)
```
client_id=…&client_secret=…&grant_type=client_credentials
→ {"access_token":"jostpf5q0…","expires_in":5011271,"token_type":"bearer"}
client_id=…&client_secret=…&grant_type=refresh_token&refresh_token=<URL-encoded>
→ {"access_token":"1ssjq…","expires_in":15583,"refresh_token":"eyJf…","scope":["moderator:read:followers"],"token_type":"bearer"}
```
Errors: a bad refresh token returns 400 `{"error":"Bad Request","status":400,"message":"Invalid refresh token"}`, or 401 if it's no longer valid. Then an officer must re-run the consent flow, so alert them.

### 3b. Validate: `GET https://id.twitch.tv/oauth2/validate` (`Authorization: OAuth <token>` or `Bearer`)
`200 {"client_id":"…","login":"lsr_club","scopes":["moderator:read:followers"],"user_id":"141981764","expires_in":5520838}`. For an app token, `login` and `user_id` are `null`. If the token is invalid: `401 {"status":401,"message":"invalid access token"}`.

### 3c. Get Users: `GET /helix/users?login=<club_login>` (once, to get `TWITCH_BROADCASTER_ID`)
Up to 100 `id` + `login` combined. Returns `{"data":[{"id":"141981764","login":"twitchdev","display_name":"TwitchDev","broadcaster_type":"partner","profile_image_url":"https://…","created_at":"2016-12-14T20:32:28Z"}]}`. `view_count` is **deprecated** and invalid, so don't use it as "channel views". Errors: 400 (no id/login with an app token, or too many), 401.

### 3d. Get Streams (live now + viewer polling): `GET /helix/streams?user_id=<id>`
An app token works. An offline channel is simply **absent**, which is not an error:
```json
{"data":[{"id":"40952121085","user_id":"101051819","user_login":"afro","game_id":"32982","game_name":"Grand Theft Auto V",
  "type":"live","title":"…","viewer_count":1490,"started_at":"2021-03-10T03:18:11Z","language":"en",
  "thumbnail_url":"https://static-cdn.jtvnw.net/previews-ttv/live_user_afro-{width}x{height}.jpg","tags":["English"]}],
 "pagination":{}}
```
- Live means `data.length > 0 && data[0].type === "live"`; `type` is `""` on error.
- `id` is the **stream id**. It equals the EventSub `event.id` and a VOD's `stream_id`, so it's our join key.
- `tag_ids` and `is_mature` are deprecated.
- Errors: 400 (bad `type`), 401.

### 3e. Get Channel Information: `GET /helix/channels?broadcaster_id=<id>`
An app token works, and it answers even when offline: `{"data":[{"broadcaster_id":"…","broadcaster_login":"…","title":"…","game_id":"…","game_name":"…","tags":[…]}]}`. Use it as a fallback for the go-live post's title and game while Get Streams lags (section 6). Errors: 400, 401, 429.

### 3f. Get Videos (past broadcasts + view_count): `GET /helix/videos?user_id=<id>&type=archive&sort=time&first=100`
- `id`, `user_id` and `game_id` are mutually exclusive.
- `type` takes `all`, `archive` (VODs), `highlight` or `upload`; `period` takes `all`, `day`, `week` or `month`.
- `after`/`before` cursors only work with `user_id`. Up to 100 `id`s for a refresh by id.

Example (adapted: the docs' example is an `upload` with `stream_id: null`, `duration: "3m21s"` and a `muted_segments` array):
```json
{"data":[{"id":"335921245","stream_id":"40952121085","user_id":"141981764","title":"…","created_at":"2018-11-14T21:30:18Z",
  "published_at":"2018-11-14T22:04:30Z","url":"https://www.twitch.tv/videos/335921245",
  "thumbnail_url":"https://static-cdn.jtvnw.net/cf_vods/…/thumb/index-0000000000-%{width}x%{height}.jpg",
  "view_count":1863062,"type":"archive","duration":"3h21m4s","muted_segments":null}],
 "pagination":{"cursor":"eyJiI…"}}
```
- `stream_id` is null for anything that isn't an archive.
- `duration` looks like `1h2m3s`. The docs call it ISO 8601, but it isn't; parse it with `/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/`.
- Thumbnails must be 320x180 (`%{width}` placeholders, unlike streams' `{width}`).
- Errors: 400 (missing or conflicting filters, bad enum), 401, 404 (all ids not found).

### 3g. Get Channel Followers (total): `GET /helix/channels/followers?broadcaster_id=<id>&first=1`
`{"total":8,"data":[{"user_id":"11111","user_login":"…","user_name":"…","followed_at":"2022-05-24T22:22:08Z"}],"pagination":{"cursor":"…"}}`.
- We only read `total`; `first=1` keeps the payload small.
- `data` is `[]` without the scope or role.
- `user_id=` checks one follower; it needs the scope.
- Errors: 400 (bad broadcaster_id), 401 (no or invalid token, client mismatch, `user_id` used without the scope or role).
- The docs contradict themselves on "401 vs total-only without scope", so test against the real API.

### 3h. EventSub subscriptions (app token; run from a one-off `scripts/twitch-eventsub.ts`, not at request time)
**Create:** `POST /helix/eventsub/subscriptions`, `Content-Type: application/json`:
```json
{"type":"stream.online","version":"1","condition":{"broadcaster_user_id":"1337"},
 "transport":{"method":"webhook","callback":"https://<prod-host>/api/twitch/eventsub","secret":"<TWITCH_EVENTSUB_SECRET>"}}
```
`202 {"data":[{"id":"26b1c993-…","status":"webhook_callback_verification_pending","type":"stream.online","version":"1","condition":{…},"created_at":"…","transport":{"method":"webhook","callback":"…"},"cost":1}],"total":1,"total_cost":1,"max_total_cost":10000}`.
- Twitch then sends the challenge (section 4). If we answer correctly, the status becomes `enabled`.
- Repeat with `stream.offline` v1. Optionally add `channel.update` v2 (title or category changed).
- Errors:
  - 400: bad condition or secret length, callback not HTTPS:443, bad type/version
  - 401: user token, or client mismatch
  - 403: missing scope
  - **409**: the same type+condition already exists. Treat it as success. The reference says the error response's `id` is the existing subscription; fall back to a List lookup if it's missing.
  - 410: the version was removed
  - 429: more than 3 subscriptions with the same type+condition

**List:** `GET /helix/eventsub/subscriptions?type=stream.online` (or `status=`, `user_id=`, `subscription_id=`; **only one filter**, and **no `first`**; page with `after`). It returns `data[]` oldest first, plus `total`, `total_cost`, `max_total_cost` and `pagination`. Statuses to watch: `enabled`, `webhook_callback_verification_pending`, `webhook_callback_verification_failed`, `notification_failures_exceeded`, `authorization_revoked`, `user_removed`, `version_removed`. `total` lags by a few seconds.

**Delete:** `DELETE /helix/eventsub/subscriptions?id=<uuid>` returns 204, 400 (no id), 401, or 404. Delete all subscriptions **before** deleting the Twitch app; otherwise they keep firing.

## 4. Webhooks: EventSub (webhook transport)

**Callback rules:** HTTPS on port **443**, and **redirects are not followed**. Use the canonical prod host exactly: if apex→www (or the reverse) redirects, or trailing-slash rewrites kick in, verification fails. Never use preview URLs, which change and sit behind Deployment Protection.

**Headers on every request** (case-insensitive; `Headers.get()` handles that):
- `Twitch-Eventsub-Message-Id`: same id on resends, so use it to dedupe
- `Twitch-Eventsub-Message-Retry`
- `Twitch-Eventsub-Message-Type`: `notification` | `webhook_callback_verification` | `revocation`
- `Twitch-Eventsub-Message-Signature`: `sha256=<hex>`
- `Twitch-Eventsub-Message-Timestamp`: RFC3339 with **nanoseconds**
- `Twitch-Eventsub-Subscription-Type`
- `Twitch-Eventsub-Subscription-Version`

**Signature (exact):** `HMAC-SHA256(key = secret, message = message_id + message_timestamp + raw_body)` as lowercase hex, prefixed with `sha256=`. Compare it to the header with a timing-safe compare; on a mismatch return **4xx** (the docs' sample sends 403). The raw body must be the exact bytes, so read `await req.text()` **before** `JSON.parse`. Challenges are signed too, so verify them as well.
```ts
const raw = await req.text();
const h = (n: string) => req.headers.get(n) ?? "";
const id = h("twitch-eventsub-message-id"), ts = h("twitch-eventsub-message-timestamp");
const expected = "sha256=" + createHmac("sha256", process.env.TWITCH_EVENTSUB_SECRET!).update(id + ts + raw).digest("hex");
const got = h("twitch-eventsub-message-signature");
if (got.length !== expected.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return new Response(null, { status: 403 });
```
**Replay guard (from the docs):** reject a `message_timestamp` older than 10 min, and ignore message ids already seen (store them with a unique index). For a **duplicate**, return 2xx without processing it, so it doesn't count as a delivery failure (the docs only say not to reprocess it; the 2xx is our choice). Node parses the 9-digit fraction fine (checked: `Date.parse("2019-11-16T10:11:12.634234626Z")` on Node 24 gives the right ms), and Vercel functions run Node, so normalizing to ms first is only a defensive step.

**Challenge:** body `{"challenge":"pogchamp-kappa-360noscope-vohiyo","subscription":{…,"status":"webhook_callback_verification_pending"}}`. Respond **200** with the **raw challenge string only** (Content-Length = its length). The docs' sample sends it as `text/plain`, so do the same: `new Response(body.challenge, {status: 200, headers: {"Content-Type": "text/plain"}})`. Don't let a framework JSON-wrap it.

**Notification (`stream.online` v1):**
```json
{"subscription":{"id":"f1c2a387-…","type":"stream.online","version":"1","status":"enabled","cost":0,
  "condition":{"broadcaster_user_id":"1337"},"transport":{"method":"webhook","callback":"…"},"created_at":"2019-11-16T10:11:12.634234626Z"},
 "event":{"id":"9001","broadcaster_user_id":"1337","broadcaster_user_login":"cool_user","broadcaster_user_name":"Cool_User",
  "type":"live","started_at":"2020-10-11T10:11:12.123Z"}}
```
- `event.type` is one of `live`, `playlist`, `watch_party`, `premiere` or `rerun`. **Only post to Discord for `live`.**
- `stream.offline` has the same envelope. Its event carries `broadcaster_user_*`; the reference also lists `id`, and the example includes it. Neither event carries the title, game or viewers, so fetch them (3d/3e).

**Revocation:** body is just `subscription`, with `status` set to `authorization_revoked`, `user_removed`, `notification_failures_exceeded` or `version_removed`. Respond 2xx, mark the subscription dead, alert officers and re-subscribe. Subscriptions don't expire, but Twitch can revoke them at any time.

**Timing:** respond within "a few seconds". Too many slow or failed responses lead to `notification_failures_exceeded`, then revocation. In the route: verify, insert the event row (unique on message id and on stream id), return 204, and do the Discord post and Helix lookups in `after()`. Delivery is at-least-once.

## 5. Rate limits, quotas, plan limits, retention

- **Helix:** a token bucket per client ID, refilled per minute. There's one bucket for app-token calls and one per client+user for user-token calls. Most endpoints cost 1 point.
  - The docs' example headers show `Ratelimit-Limit: 800`; our real limit is **UNVERIFIED**, so read the headers.
  - Response headers: `Ratelimit-Limit`, `Ratelimit-Remaining`, `Ratelimit-Reset` (Unix epoch). On a 429, wait until Reset. Some 429s aren't bucket-related; check the message.
  - Our load is about 1–3 calls/min while live, which is negligible.
- **EventSub:**
  - `max_total_cost` shows as 10,000 in every webhook example, but the docs never state it as a rule ("grows as users authorize your application"). Read it from the responses. (The 10 in the docs applies to WebSockets, not webhooks.)
  - `stream.online` and `stream.offline` cost 1 each, or **0 once the broadcaster has authorized our client ID**. The docs' worked example shows any scope counts: a user who granted only `channel:moderate` makes `stream.online` cost 0.
  - At most 3 subscriptions with the same type+condition.
  - Disabled webhook subscriptions stay listed for at least 10 days.
- **No paid plan exists.** The API and EventSub are free.
- **Retention on Twitch:**
  - Past broadcasts expire. Third-party sources (Archive Team wiki, Streamlabs) say 7 days by default, 14 for Affiliates, and 60 for Partners/Turbo/Prime (a few say 60 for Affiliates). That's **UNVERIFIED** (the help center is JS-only), and Twitch's "Store past broadcasts" setting must be on.
  - Highlights and uploads are capped at 100 hours per channel, effective April 19, 2025, with the least-viewed highlights deleted first. Past broadcasts and clips are excluded (TechCrunch, 2025-02-20; **UNVERIFIED** against the help center).
  - So **snapshot VOD metadata and view_count daily**. Once a VOD is gone, Get Videos returns 404 / omits it.
- **pg_cron cadence:** 1 min while a `stream.online` session is open (sample viewers). Every 10 min while offline, as a backstop for a missed webhook. Daily for VODs and the follower total.

## 6. Gotchas, policy/terms constraints, privacy notes

- **Get Streams lags behind reality.** Forum reports describe it as empty for up to a few minutes after going live, and flipping online/offline between cache nodes, which is more likely when polling faster than once a minute (**UNVERIFIED**, community, no staff reply found). Don't poll faster than our 1/min.
  - For the Discord post, use the EventSub event plus Get Channel Information, and retry Get Streams with backoff to get the thumbnail.
  - Never close a session on a single empty poll; trust `stream.offline`, or N consecutive empty polls.
- **Reconnects:** an encoder drop can produce offline→online with a new stream id (**UNVERIFIED**). Debounce the Discord post: skip it if we posted within the last ~15 min.
- `viewer_count` is concurrent viewers, not unique viewers, and it's cached. Store raw samples and derive peak and average from them.
- **VOD views:** the `view_count` on an `archive` VOD keeps rising after the stream; that's why we snapshot daily. The VOD of a live stream may already exist while live (**UNVERIFIED**).
- **Token rules:**
  - EventSub webhook calls fail with a user token, so keep the two token paths separate.
  - App tokens can't be refreshed; on a 401, mint a new one.
  - Validate the user token hourly (pg_cron); Twitch audits non-validating apps.
- **Developer Services Agreement (24-hour rule).** Its quoted text: "Do not store copies of Twitch Content or Program Materials, unless you: (a) obtain prior written authorization… (b) control the rights associated with such content; or (c) cache such information for only a twenty-four hour time period without further sharing it with third parties."
  - Twitch staff (jbulava, forum, 2025-07-14): with an OAuth grant from the user, storing beyond 24 h is "generally" compliant.
  - It's our own channel and we'd have the club's OAuth grant, so long-term stats should be fine. Whether sending the stats to an LLM provider counts as "sharing with third parties" is **UNVERIFIED**; we only send our own channel's aggregates. I could not read the agreement itself (legal.twitch.com is rendered client-side).
- **Privacy:** the follower list holds other users' logins. We don't need it, so store **only `total`**. Request no `user:read:email` or other scopes.
- **Account custody:** the dev app and the OAuth grant belong to the club Twitch account, which has 2FA. If its password changes, user tokens and subscriptions that depend on the grant are revoked. Write the re-consent steps into the runbook.
- **Callback:** raw body before parsing; HTTPS 443; no redirects. Next's default (no trailing slash) is fine; just subscribe to the exact path.
- Helix may add fields and enum values without notice, so parse leniently (ignore unknown keys, treat unknown `type` values as not live).

## 7. How to fake it locally

**Wiring:** our client reads `TWITCH_API_BASE` and `TWITCH_AUTH_BASE`. The fake is a small Node HTTP server under `apps/platform/scripts/fakes/twitch/`, plus a CLI to "go live", "go offline" and so on.

**Off-the-shelf cross-checks:**
- `twitch mock-api start` (Twitch CLI): base `http://localhost:8080/mock`. Its auth is **different** (`POST /auth/token?…`, 24 h tokens, no refresh) and it has **no EventSub**, so it can't replace our fake.
- `twitch event verify-subscription streamup -F http://localhost:3000/api/twitch/eventsub -s $SECRET` and `twitch event trigger streamup|streamdown -t <broadcaster_id> -F … -s $SECRET` sign real-format webhooks. The docs' examples forward to `https://localhost:8080`; plain `http://` to our dev server is common practice but not stated (**UNVERIFIED**). Use them to prove the **handler** and our **fake sender** agree.

**Fake API must reproduce:**
- **Auth:**
  - `POST /oauth2/token` (form body) for `client_credentials`, `authorization_code` and `refresh_token`. Return the shapes in 3a. Rotate refresh tokens on each refresh; a stale one returns 400 "Invalid refresh token".
  - `GET /oauth2/validate` per 3b, with `login`/`user_id` null for app tokens.
  - Knobs to expire or revoke a token, so the next call returns 401 (this tests mint and refresh).
- **Request checks:** require `Authorization: Bearer` + `Client-Id`; on a mismatch, 401. Track whether each token is an app or user token and its scopes. EventSub endpoints given a user token return 401.
- **Helix state machine:**
  - The channel is offline (`{"data":[],"pagination":{}}`) or live (one stream with a new string `id`, `type:"live"`, a `viewer_count` that random-walks on each call, `started_at`, `{width}x{height}` thumbnail).
  - A "lag" knob returns empty for N calls after going live, and a "flap" knob alternates.
- **Other endpoints:**
  - `/channels` always returns the title and game.
  - `/videos` creates an `archive` VOD (`stream_id` = the stream id, `duration` like `1h2m3s`, `%{width}` thumbnail, `view_count` rising daily). It supports `type`, `sort`, `first` and `after` cursors, and the 400 for conflicting `id`/`user_id`. A knob expires old VODs, returning 404 when every id is missing.
  - `/channels/followers`: `total` always. `data` only for a user token with `moderator:read:followers` for this broadcaster. A mode switch for the unverified app-token behavior: `total-only` vs `401`.
- **EventSub CRUD:**
  - POST returns 202 `webhook_callback_verification_pending`, then **sends a signed challenge** to the callback. If the body equals the challenge (status 200), the subscription becomes `enabled`; otherwise `webhook_callback_verification_failed`.
  - 409 on a duplicate type+condition; 400 if the secret isn't 10–100 chars or the callback isn't https.
  - `total`, `total_cost` and `max_total_cost: 10000`; GET with one filter only; DELETE returns 204 or 404.
- **Limits and errors:** `Ratelimit-*` headers on every response, a knob for 429 or a single 503, and error bodies shaped `{error, status, message}`.

**Fake EventSub sender must reproduce:**
- All 7 headers, a fresh message id, and a timestamp with **9 fractional digits**. The signature is `sha256=` + hex HMAC of `id + timestamp + body`, sent as the exact bytes signed.
- `stream.online` (with `type` = `live`, and a `rerun` variant) and `stream.offline`, both using the envelope in section 4.
- **Chaos knobs:**
  - a duplicate (same message id, `Twitch-Eventsub-Message-Retry` set)
  - a stale timestamp (more than 10 min)
  - a bad signature
  - an offline→online flap within 1 min with a new stream id
  - out of order (offline before online)
  - `revocation` with each status
- **Delivery accounting:** count responses that aren't 2xx or take more than 3 s (our pick for "a few seconds"). After N of them, flip to `notification_failures_exceeded` and send a revocation.

## 8. Sources

- https://dev.twitch.tv/docs/api/reference/: Get Streams, Get Videos, Get Users, Get Channel Information, Get Channel Followers, Create / Get / Delete EventSub Subscription
- https://dev.twitch.tv/docs/api/guide/: rate limits, pagination, timestamps, breaking changes
- https://dev.twitch.tv/docs/authentication/
- https://dev.twitch.tv/docs/authentication/register-app/
- https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
- https://dev.twitch.tv/docs/authentication/refresh-tokens/
- https://dev.twitch.tv/docs/authentication/validate-tokens/
- https://dev.twitch.tv/docs/authentication/scopes/
- https://dev.twitch.tv/docs/eventsub/: duplicates, replay attacks
- https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
- https://dev.twitch.tv/docs/eventsub/manage-subscriptions/: auth, costs, limits
- https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/: stream.online, stream.offline, channel.update
- https://dev.twitch.tv/docs/eventsub/eventsub-reference/: Stream Online / Offline event, Subscription, Transport
- https://dev.twitch.tv/docs/cli/mock-api-command/
- https://dev.twitch.tv/docs/cli/event-command/
- https://discuss.dev.twitch.com/t/get-followers-count/48066: app token returns the follower total (community)
- https://discuss.dev.twitch.com/t/follows-endpoints-and-eventsub-subscription-type-are-now-available-in-open-beta/43322: follows changes, the 2023 shutdown of Get Users Follows
- https://discuss.dev.twitch.com/t/storage-of-data-from-twitch-api/63884: the DSA 24-hour clause and the staff reply
- https://discuss.dev.twitch.com/t/question-regarding-persistent-storage-of-clip-ids-and-metadata/63743
- Search-result summaries only (pages not opened): Get Streams cache lag (discuss.dev.twitch.com threads 61608, 24118), VOD retention (Streamlabs and others), wiki.archiveteam.org/index.php/Twitch
- https://discuss.dev.twitch.com/t/get-streams-endpoint-forgets-stream-after-a-while/31136: cache flicker when polling faster than 1/min (community)
- https://techcrunch.com/2025/02/20/twitch-caps-streamers-storage-at-100-hours-of-highlights-and-uploads: the 100-hour cap, effective April 19

## 9. Checked

Re-checked 2026-10-22 against the live pages at dev.twitch.tv (API reference, API guide, authentication, register-app, getting-tokens, refresh-tokens, validate-tokens, EventSub overview, handling-webhook-events, manage-subscriptions, subscription types, EventSub reference, CLI mock-api and event pages), plus the forum threads cited.

**Verified (matches the docs):**
- URLs, methods and token types for Get Users, Get Streams, Get Channel Information, Get Videos, Get Channel Followers, and Create / Get / Delete EventSub Subscription. That includes "webhook EventSub needs an app token; a user token fails", Delete returning 204, and List taking one filter only, no `first`, oldest first, with `total` lagging "a few seconds".
- All response codes listed in section 3, including 409 (duplicate), 410 (version removed) and 429 (more than 3 with the same type+condition), plus the 10–100 ASCII-char secret and "HTTPS, port 443, redirects not followed".
- Get Followers: `moderator:read:followers` and broadcaster-or-mod, the "only the total" sentence, and the contradicting 401 list.
- Get Videos: the `id`/`user_id`/`game_id` exclusivity, cursors only with `user_id`, 320x180 `%{width}` thumbnails, the "ISO 8601" `duration` that's really `3m21s`, and the 404 only when every id is missing.
- `stream.online` and `stream.offline` are v1 with "No authorization required", `channel.update` is v2, and `event.type` takes live, playlist, watch_party, premiere or rerun.
- Signature: HMAC-SHA256 over id + timestamp + raw body, `sha256=` hex, and 4xx on a mismatch. Also verified: the 7 headers, nanosecond RFC3339 timestamps, the 10-minute replay window, deduping on message id, the challenge answered with 200 and the raw string, "a few seconds" to respond, the revocation statuses, and 2xx on a revocation.
- Costs: 1, or 0 once the user has authorized the app (any scope, per the docs' example). Disabled webhook subscriptions stay listed for at least 10 days. Delete subscriptions before deleting the app.
- Rate limits: a token bucket, a default cost of 1 point, separate app and per-user buckets, the three `Ratelimit-*` headers (Reset is a Unix epoch), 800 shown only as an example, non-bucket 429s, and "retry once" on a 503.
- Auth:
  - App tokens can't be refreshed, and the client-credentials example shows `expires_in: 5011271`.
  - The refresh token must be URL-encoded. Confidential-client refresh tokens don't expire but may change. One refresh token backs at most 50 valid access tokens.
  - A bad refresh token gives 400 "Invalid refresh token", or 401.
  - Validate at startup and hourly, which Twitch audits. `OAuth` or `Bearer` both work, and an app token's `login` and `user_id` come back null.
  - Registering an app needs 2FA. **New Secret** invalidates the old secret, and sharing client IDs risks suspension.
- Twitch CLI: the mock API is at `localhost:8080/mock`, its app token comes from `POST /auth/token`, tokens last 24 h with no refresh, and EventSub is unsupported. `streamup`/`streamdown` work with `-F`, `-s` and `-t`.
- The DSA 24-hour clause text and the jbulava staff reply (2025-07-14) match the forum thread.

**Corrected:**
- `max_total_cost` 10,000 is only an example value in the docs, not a stated limit. The doc now says to read it from responses.
- The highlight/upload 100-hour cap took effect on **April 19, 2025**, not "about May 2025". Past broadcasts and clips are excluded.
- The Helix error-body shape was marked UNVERIFIED, but it appears in the Helix reference (Ban User example), so it's resolved.
- Node's handling of 9-digit fractions was UNVERIFIED. It's now resolved: tested on Node 24, it works.
- 409 on Create: the reference says the error carries the existing subscription's `id`. Added.
- The Get Videos example is now labeled as adapted from the docs' `upload` example.
- `text/plain` on the challenge is the docs' sample, not a stated requirement. The duplicate-returns-2xx rule is our choice; the docs only say "don't reprocess".
- The CLI over plain HTTP was stated as fact. The docs' examples use https, so it's now marked UNVERIFIED.

**Still UNVERIFIED:**
- Whether an app token returns the follower total. Only the community says so; the fake keeps both modes.
- Whether New Secret invalidates existing app tokens.
- Get Streams cache lag and flapping, and whether a reconnect produces a new stream id.
- Whether a live stream's VOD exists while it's still live.
- VOD retention days, and the 100-hour cap against the help center (JS-only).
- Our real Helix rate limit (read the headers).
- Whether sending stats to an LLM provider is "sharing with third parties" under the DSA. legal.twitch.com still renders client-side.
