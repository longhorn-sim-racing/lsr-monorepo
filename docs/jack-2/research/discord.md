# Discord bot (read, post, events, roles, account linking): research spec

Researched 2026-10-22, mostly from Discord's own docs (`docs.discord.com/developers/...`, read as raw `.md`), the docs change log, the live OAuth metadata, and the Developer Policy and Terms. Anything not confirmed is marked **UNVERIFIED**.

**Bottom line:** everything in the goals works over **REST alone, with no gateway daemon**. We read by polling (pg_cron → pg_net → a Vercel route) and write with plain `POST/PATCH/PUT/DELETE`. Optional slash commands would come in over a signed HTTP interactions endpoint. Two premises in the brief are out of date:
1. **Bots can now search messages.** `GET /guilds/{id}/messages/search` has been documented for bots since 2026-03-19, and it needs the Message Content intent.
2. **The privileged-intent threshold is no longer "100 servers".** Since 2026-06-10, apps that fewer than **10,000 unique users** can see just flip a toggle in the portal. No review is needed.

## 1. What we'd use it for

The LSR Discord bot gives Jack three things:
- **(a) Read data.** It lists channels and syncs message history (`after=` cursor, cron-driven) into Postgres. It reads poll results and voters, and computes activity: messages per channel per day, distinct active members, member count and joins. Jack can also run ad-hoc searches through the search endpoint.
- **(b) Write, officer-approved or under standing rules.** It posts messages and embeds, creates polls, creates/edits/deletes external Guild Scheduled Events and reads their `user_count`, and adds/removes roles so Discord roles match site roles (role sync).
- **(c) Account linking.** Members link Discord on the website with OAuth2 `identify`, so we can store `discordUserId` against `User`. Today `LeagueApplication.discordUsername` is a typed string, and usernames are not unique.

Nothing here moves money. The bot token is the one high-value secret: keep it server-only, never in Jack's context, and wrap it in a client that allow-lists routes.

## 2. Auth and setup

**Create the app:** discord.com/developers/applications → New Application.
- **General Information:** copy the Application ID (= client id) and Public Key. Set the **Privacy Policy URL** (required by the Terms, see §6) and the ToS URL. Our `/privacy` page exists but doesn't mention Discord yet.
- **Bot tab:**
  - Reset Token, copy it once.
  - Turn **Public Bot OFF**, so only the owner can add the bot to servers.
  - Leave "Requires OAuth2 Code Grant" off.
  - Under Privileged Gateway Intents, toggle **Server Members** (needed for `List Guild Members`) and **Message Content** only if we store or search content (see §6). Toggles are enough under 10k users.
- **OAuth2 tab:** add redirect URIs (`https://<site>/api/discord/oauth/callback` plus a localhost one) and copy the client secret.
- **Installation:** guild install only. With Public Bot off, only the app owner can add the bot, so run the install URL below logged in as the owner account. That account also needs Manage Server on the LSR guild.

**Bot install URL (no redirect):**
```
https://discord.com/oauth2/authorize?client_id=$APP_ID&scope=bot&permissions=580542407986176&guild_id=$GUILD_ID&disable_guild_select=true
```
**Permissions integer `580542407986176`** = VIEW_CHANNEL (1<<10) + SEND_MESSAGES (1<<11) + EMBED_LINKS (1<<14) + READ_MESSAGE_HISTORY (1<<16) + MANAGE_ROLES (1<<28) + CREATE_EVENTS (1<<44) + SEND_POLLS (1<<49).
- Add ATTACH_FILES (1<<15) to post Jack's rendered graphics, and SEND_MESSAGES_IN_THREADS (1<<38) to post in threads. With both: `580817285925888`.
- Read-only would be `66560`.
- Not requested: MANAGE_EVENTS (only needed to edit events *others* created), MENTION_EVERYONE, MANAGE_MESSAGES, ADMINISTRATOR.
- Narrow further with channel overwrites: deny VIEW_CHANNEL on channels we must not read. From 2026-11-16, `Get Guild Channels` simply omits them.
- **Role hierarchy:** the bot can only grant or remove roles positioned **below its own highest role**. Place the bot role just above the synced roles (e.g. Member, LSC Driver) and below officer/admin roles.
- MANAGE_ROLES is an "elevated" permission, so if the server enforces 2FA for moderation, the **app owner's account must have 2FA**.

**Tokens:**
- **Bot token:** header `Authorization: Bot <token>`. The docs give no lifetime; it lasts until it's reset. GitHub lists "Discord Bot Token" as a secret-scanning **partner** pattern, so a token pushed to a public GitHub repo is reported to Discord. **UNVERIFIED:** that Discord then auto-resets it. Only third parties say so; Discord's docs don't. Developer Terms §2(d) also say credentials can't go in open-source projects and must be encrypted in any file third parties can reach.
- **User OAuth tokens** (linking only): `expires_in: 604800` (7 days) in the docs example, plus a `refresh_token`. The refresh-token lifetime is **undocumented**. We don't need to keep user tokens at all: exchange the code, call `/users/@me`, store the id, then revoke the token.
- **Interaction tokens** (if we add slash commands): 15 minutes, and the first response must be sent within 3 s.
- **Client credentials** (token and revoke endpoints): HTTP Basic (`client_id:client_secret`) or form fields.

**Account linking flow** (Authorization Code + PKCE; live metadata lists `code_challenge_methods_supported: ["S256"]`):
1. Redirect to `https://discord.com/oauth2/authorize?response_type=code&client_id=…&scope=identify&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&prompt=none`. `prompt=none` skips re-consent if the user already approved. Discord recommends `state` but doesn't require it; we use it.
2. The callback receives `?code&state&iss=https://discord.com`. Since 2026-10-14, check that `iss` equals the issuer.
3. `POST https://discord.com/api/oauth2/token`. The body must be **`application/x-www-form-urlencoded`; JSON is rejected**: `grant_type=authorization_code&code&redirect_uri[&code_verifier]`.
4. `GET /users/@me` with `Bearer`. Store `id`, plus `username`/`global_name` for display only.
5. `POST /oauth2/token/revoke` with `token`. Revoking one token revokes the whole grant.

Alternative: Supabase Auth's Discord provider plus `linkIdentity()`. That needs the beta "manual linking" setting turned on. Supabase's docs say `linkIdentity()` works with OAuth providers but only show Google; they don't name Discord. Supabase Auth's source (`internal/api/provider/discord.go`) shows the Discord provider:
- always asks for the **`email` and `identify`** scopes, which is more than we need;
- maps `sub`/`provider_id` to the Discord user id;
- also stores `name` (`username#discriminator`), `full_name`, `picture`, `email` and `custom_claims.global_name`.

That comes from the source code, not the docs, so test it before relying on it.

**Env vars** (Vercel Production, Sensitive; `.env.local` points at the fake):
- `DISCORD_APPLICATION_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_PUBLIC_KEY` (only if we add interactions)
- `DISCORD_GUILD_ID`
- `DISCORD_OAUTH_REDIRECT_URI`
- `DISCORD_API_BASE` (default `https://discord.com/api/v10`)
- `DISCORD_OAUTH_AUTHORIZE_URL` (default `https://discord.com/oauth2/authorize`)
- the existing cron shared secret, for the pg_net → route call

## 3. Endpoints we need

**Every request:**
- Base `https://discord.com/api/v10`.
- `User-Agent: DiscordBot (https://<site>, 1.0)`. Required: the docs say requests without a valid User-Agent "may be blocked".
- `Content-Type: application/json` on bodies. Without it you get error `50035`.

**Data rules:**
- IDs are snowflake **strings**. Never parse them to a JS `number`; store them as `text` or `bigint`.
- Snowflake → ms: `(id >> 22) + 1420070400000`. ms → cursor: `(ms - 1420070400000) << 22`, which lets you start a sync "from date X".
- Array query params repeat the key (`?channel_id=1&channel_id=2`). Booleans are `true`/`false`.

**Errors to handle everywhere:**
- Body shape: `{code, message, errors?}`.
- `401` → stop, token is bad.
- `403` + `50001` (Missing access) or `50013` (Missing permissions).
- `404` + `10003` (channel), `10004` (guild), `10007` (member), `10008` (message), `10011` (role), `10070` (scheduled event).
- `400` + `50035` (invalid form body, field errors nested under `errors`).
- `429`, see §5.

**R1. Guild + counts:** `GET /guilds/{guild_id}?with_counts=true`
```json
{"id":"1100000000000000000","name":"Longhorn Sim Racing","system_channel_id":"1100000000000000007",
 "approximate_member_count":412,"approximate_presence_count":96}
```

**R2. List channels:** `GET /guilds/{guild_id}/channels`. No pagination. **Threads are not included.** From 2026-11-16, channels the bot can't view are omitted.
```json
[{"id":"1100000000000000010","type":0,"guild_id":"1100…","name":"general","parent_id":"1100…01","position":2,
  "last_message_id":"1300000000000000555","topic":null,"nsfw":false,"flags":0}]
```
- Text-like types: 0 text, 5 announcement, 15 forum (threads only), 16 media.
- Threads: 10, 11, 12.
- Others: 2 voice, 4 category.
- For threads, also call `GET /guilds/{id}/threads/active` → `{threads:[channel], members:[…]}` and `GET /channels/{id}/threads/archived/public?before=<ISO8601>&limit=` → `{threads, members, has_more}`. The archived list needs READ_MESSAGE_HISTORY.

**R3. Message history:** `GET /channels/{channel_id}/messages?after=<id>|before=<id>|around=<id>&limit=1..100`
- Default limit 50. `before`, `after` and `around` are mutually exclusive.
- Returned **newest → oldest**.
- Needs VIEW_CHANNEL, and READ_MESSAGE_HISTORY; without READ_MESSAGE_HISTORY it returns an **empty array, not an error**.
- **Incremental sync:** `after=<max stored id>&limit=100`. Sort the page by id, store it, and repeat until the page has fewer than 100 messages.
- **Backfill:** `before=<min id>`, repeated.
- **UNVERIFIED** (the docs don't say): with `after`, the page is the 100 messages immediately after the cursor, still ordered newest-first. discord.py's `after` pager relies on this: it uses `data[0]`, the newest message on the page, as the next cursor.
```json
[{"id":"1300000000000000556","channel_id":"1100…10","type":0,"timestamp":"2026-10-21T23:05:11.123000+00:00",
  "edited_timestamp":null,"author":{"id":"2200…","username":"arav","global_name":"Arav","bot":false},
  "content":"GM slides are up","attachments":[],"embeds":[],"mentions":[],"mention_roles":[],"pinned":false,
  "reactions":[{"count":3,"emoji":{"id":null,"name":"🔥"}}],"message_reference":null,
  "thread":{"id":"…","name":"…"},"poll":{ /* see R6 */ }}]
```
- Fields we keep: `id, channel_id, type, timestamp, edited_timestamp, author.id/username/global_name/bot, webhook_id, content, reactions[].count, poll, message_reference, thread.id`.
- **Without Message Content:** `content`, `embeds`, `attachments` and `components` come back empty and `poll` is **omitted**. Documented exceptions: the bot's own messages, DMs with the bot, messages that mention it, and the target of a message context-menu command. Replies to the bot aren't listed; they probably count only when the reply pings the bot (**UNVERIFIED**).
- Activity metrics (author, timestamp, channel) **don't need the intent**.
- System message types worth knowing: 7 `USER_JOIN`, 19 reply, 46 `POLL_RESULT`.

**R4. Search (new, bots allowed, needs Message Content):** `GET /guilds/{guild_id}/messages/search?content=lsc&channel_id=…&author_id=…&min_id=&max_id=&sort_by=timestamp|relevance&sort_order=desc&limit=25&offset=0`
- Limits: `limit` 1–25 (default 25), `offset` max 9975, `content` max 1024 chars, `channel_id` up to 500 values, `author_id` and `mentions` up to 100 each. `sort_order` is `asc|desc` and is ignored for relevance sorting.
- Other filters: `has=image|sound|video|file|sticker|embed|link|poll|snapshot`, `author_type=user|bot|webhook`, `pinned`, and `include_nsfw` (default false, which skips age-restricted channels).
- The docs only say the endpoint is "restricted according to" the Message Content intent. They don't give the error you get without it.
- Needs READ_MESSAGE_HISTORY. Results have **no `reactions`**.
```json
{"total_results":3,"doing_deep_historical_index":false,"messages":[[{ /* message */ }],[{ }]],"threads":[]}
```
- `messages` is an array of 1-element arrays; flatten it.
- **`202`** with `{"message":"Index not yet available. Try again later","code":110000,"documents_indexed":0,"retry_after":2}` → retry after `retry_after`, or after a short delay if it's 0.
- Don't paginate by array length, because pages can come back short.

**R5. Members and joins:** `GET /guilds/{guild_id}/members?limit=1..1000&after=<highest user id so far>`
- Default limit **1**. **Requires the Server Members intent.**
```json
[{"user":{"id":"2200…","username":"arav","global_name":"Arav","bot":false},"nick":null,"roles":["1100…20"],
  "joined_at":"2026-08-25T17:02:00.000000+00:00","pending":false,"flags":0}]
```
- **Joins per day:** group by `joined_at`. **Leaves:** diff against yesterday's snapshot. There is no join/leave history API without the gateway. Type-7 `USER_JOIN` messages in the system channel are a backup signal.
- Without the intent: `GET /guilds/{id}/members/{user_id}` for one member (also a good check that a linked user is in the server), or `GET /guilds/{id}/members/search?query=&limit=`.
- `GET /guilds/{id}/roles/member-counts` → `{"<role_id>": 37}` (the doc doesn't state the permission).
- Errors: `10007` = user not in the server.

**R6. Polls (read):** the poll lives on the message (`message.poll`):
```json
{"question":{"text":"GM 2 night?"},"answers":[{"answer_id":1,"poll_media":{"text":"Mon"}},{"answer_id":2,"poll_media":{"text":"Wed"}}],
 "expiry":"2026-10-25T18:00:00.000000+00:00","allow_multiselect":false,"layout_type":1,
 "results":{"is_finalized":false,"answer_counts":[{"id":1,"count":12,"me_voted":false}]}}
```
- A missing answer in `answer_counts` = 0 votes.
- A missing `results` = **unknown**, not zero, so keep the last known value.
- Counts are exact only once `is_finalized` is true.
- Voters: `GET /channels/{channel_id}/polls/{message_id}/answers/{answer_id}?after=<user id>&limit=1..100` (default 25) → `{"users":[{"id","username","global_name"}]}`.
- **UNVERIFIED:** whether the voters endpoint itself is gated by Message Content. Either way, getting the `answer_id`s of a *member's* poll needs the intent; the bot's own polls are exempt.

**W1. Post a message or embed:** `POST /channels/{channel_id}/messages`
```json
{"content":"Lone Star Cup R3 results are up","allowed_mentions":{"parse":[]},"nonce":"jack-act-8f2c","enforce_nonce":true,
 "embeds":[{"title":"LSC R3","url":"https://<site>/lone-star-cup","description":"…","color":12536064,
   "fields":[{"name":"Winner","value":"…","inline":true}],"footer":{"text":"Longhorn Sim Racing"},"timestamp":"2026-10-22T02:00:00Z"}]}
```
- Returns the message object.
- Limits: `content` ≤2000, ≤10 embeds, ≤6000 chars across embeds, title 256, description 4096, 25 fields (name 256 / value 1024), footer 2048.
- **`enforce_nonce`:** Discord returns the existing message instead of posting a duplicate when the same author reuses a nonce (≤25 chars) within "the past few minutes". That gives us idempotent retries of approved actions.
- Edit: `PATCH /channels/{c}/messages/{m}` (own messages). Delete: `DELETE /channels/{c}/messages/{m}` → 204.
- Files: `multipart/form-data` with `payload_json` + `files[n]`. The default is 20 MiB per file (higher in boosted servers). The documented maximum request size for Create Message is 25 MiB.
- Errors: `50006` empty message, `20028` channel write rate limit, `50083` archived thread.

**W2. Create a poll:** the same POST with `{"poll":{"question":{"text":"…≤300"},"answers":[{"poll_media":{"text":"…≤55"}}],"duration":48,"allow_multiselect":false},"allowed_mentions":{"parse":[]}}`.
- ≤10 answers. `duration` is in hours, default 24, max 32 days.
- **Polls can't be edited after creation** (`520003`), and apps can't vote.
- End early: `POST /channels/{c}/polls/{m}/expire` (own polls only; `520006` if the message isn't a poll).
- `520002`: the channel type doesn't allow polls.

**W3. Scheduled events (external):** `POST /guilds/{guild_id}/scheduled-events`, header `X-Audit-Log-Reason: <url-encoded ≤512>`
```json
{"name":"General Meeting 2","description":"…","privacy_level":2,"entity_type":3,
 "scheduled_start_time":"2026-11-02T00:00:00Z","scheduled_end_time":"2026-11-02T02:00:00Z",
 "entity_metadata":{"location":"Alienware lounge"}}
```
→
```json
{"id":"1400…","guild_id":"1100…","channel_id":null,"creator_id":"<bot id>","name":"General Meeting 2","status":1,
 "entity_type":3,"entity_metadata":{"location":"Alienware lounge"},"scheduled_start_time":"…","scheduled_end_time":"…","privacy_level":2}
```
- `EXTERNAL` requires `channel_id: null`, `location` (1–100 chars) and an end time. Name is 1–100 chars, description 1–1000. `privacy_level` must be 2 (GUILD_ONLY).
- Read: `GET /guilds/{g}/scheduled-events?with_user_count=true` or `GET …/scheduled-events/{id}?with_user_count=true` (adds `user_count`).
- Edit: `PATCH …/{id}`, all fields optional, `status` included.
- Delete: `DELETE …/{id}` → 204.
- RSVPs: `GET …/{id}/users?limit=≤100&after=<user id>&with_member=false` → `[{"guild_scheduled_event_id","user":{…}}]`, ascending by user id.
- Status: 1 scheduled, 2 active, 3 completed, 4 canceled. Allowed transitions: 1→2, 2→3, 1→4. External events **auto-start and auto-complete** at their times.
- Errors: `30038` (100 scheduled/active cap), `10070`.

**W4. Role sync:** `PUT` or `DELETE /guilds/{guild_id}/members/{user_id}/roles/{role_id}` (+ `X-Audit-Log-Reason`) → **204**, no body.
- Errors: `10007` not in the server, `10011` bad role, `50013` role at or above the bot's.
- Read current roles via R5 or `GET /guilds/{g}/members/{u}` and only call for the differences.
- **UNVERIFIED:** managed roles (bot or booster roles) can't be assigned.

**H1. Health:** `GET /applications/@me` returns `flags`. GATEWAY_MESSAGE_CONTENT_LIMITED is 1<<19 and GATEWAY_GUILD_MEMBERS_LIMITED is 1<<15, so this confirms the intent toggles are on. The flags table still says "under 100 servers", which is stale wording.

## 4. Webhooks/events

- **No HTTP event feed for messages, members, polls or scheduled events.** Discord's "Webhook Events" only cover `APPLICATION_AUTHORIZED/DEAUTHORIZED`, entitlements, Social SDK lobby/DM events and quests. Real-time `MESSAGE_CREATE`, `GUILD_MEMBER_ADD`, `MESSAGE_POLL_VOTE_ADD` and `GUILD_SCHEDULED_EVENT_USER_ADD` exist **only on the gateway**, so we poll.
- **Optional interactions endpoint** (slash commands or buttons, e.g. `/jack ask`, or an "Approve" button in an officers' channel): set the Interactions Endpoint URL in the portal. Rules:
  - Discord POSTs JSON with headers `X-Signature-Ed25519` (hex) and `X-Signature-Timestamp`.
  - **Verify** Ed25519 over the bytes of `timestamp + rawBody` (the exact raw text: use `await req.text()` before `JSON.parse`) against `DISCORD_PUBLIC_KEY` (hex, 32 bytes). In Node: `crypto.verify(null, Buffer.from(ts + body), crypto.createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:b64url(pubKey)},format:'jwk'}), Buffer.from(sig,'hex'))`. On failure, respond **401**.
  - Discord **deliberately sends bad signatures** to test this, and removes the URL if we accept them.
  - `PING` `{type:1}` → `200 {"type":1}`.
  - Respond within **3 s**. For slow work (Claude), reply `{type:5}` (deferred), finish it in `after()`/`waitUntil`, then `PATCH /webhooks/{app_id}/{token}/messages/@original` within 15 min. Interaction routes don't count toward the global rate limit.
  - The docs don't specify a timestamp-freshness window. We add our own (reject if more than 5 min old).
- **Webhook Events** (only if we want `APPLICATION_DEAUTHORIZED`): same Ed25519 scheme. `PING` is `{type:0}` → **204** empty body. Ack every event with 204 within 3 s. Retries use exponential backoff for up to 10 min.

## 5. Rate limits and quotas, plan limits, data retention

**Rate limits:**
- **Global:** 50 requests/s per bot. Without auth, the limit is per IP.
- **Per-route:** numbers are **not published; don't hard-code them**. Read these headers:
  - `X-RateLimit-Limit`, `-Remaining`, `-Reset` (epoch s), `-Reset-After` (s, decimal)
  - `-Bucket`, a shared-bucket id. Key limiters by bucket + top-level resource (channel_id / guild_id / webhook).
  - On 429 only: `X-RateLimit-Global` and `X-RateLimit-Scope: user|global|shared`.
- **429** body: `{"message":"You are being rate limited.","retry_after":64.57,"global":false,"code"?}`, plus a `Retry-After` header. Sleep, then retry.
- **Invalid-request ban:** 10,000 `401/403/429` responses per **10 min per IP** brings a temporary Cloudflare ban. 429s with `scope: shared` don't count.
  - **UNVERIFIED risk:** Vercel's outbound IPs are shared, so in theory a neighbour could trip this. Keep our own 4xx rate near zero (check permissions first, stop on 401).
  - Repeatedly using a webhook that returns 404 also gets restricted.
- **UNVERIFIED** (folk numbers): about 5 messages per 5 s per channel.

**Quotas:**
- Page sizes: 100 messages, 1000 members, 100 voters, 100 RSVPs, 25 search results per page; search offset ≤9975, so ≤10k hits per query.
- 100 scheduled/active events per guild.
- Polls: ≤10 answers, ≤32 days.
- Upload: 20 MiB per file by default (raised from 10 on 2026-09-03; higher in boosted servers), 25 MiB per Create Message request.
- Audit-log reason: 1–512 chars.

**Plans:**
- The API is free; there are no paid tiers for this.
- Privileged intents need **no review under 10,000 unique users**. Above that: apply within 90 days, then re-apply yearly.
- App Verification is separate now. **UNVERIFIED:** its current threshold. It was 100 servers historically, and the 2026 docs don't restate it. This doesn't matter for us in practice: with Public Bot off, only the owner can add the bot, so it stays in one server.

**Retention:**
- Discord documents no depth limit on channel history, so paging `before=` should reach the first message. **UNVERIFIED** for very old channels.
- Attachment CDN URLs are **signed and expire** (`ex=` param). Don't store them as permanent links; re-fetch the message or download the file if we need it.
- Interaction tokens: 15 min.

**Our budget:** one 300 s function can page many thousands of messages. Make the sync **resumable**: store a per-channel cursor and stop at about 240 s.

## 6. Gotchas, policy/terms constraints, privacy notes

**Discord's terms and policy:**
- **Privacy policy is mandatory** (Developer Terms §5a). It must be public, linked in the Developer Portal and easy to reach from the app. It must say what we collect, how we use and share it ("with third parties": Anthropic, Supabase, Vercel), and how users request deletion.
  - We may share API Data only with Service Providers, when the law requires it, or when the user explicitly tells us to (§5b).
  - We must **delete API Data** when it's no longer needed for the stated function, when a user asks, when Discord asks, or when we stop operating. We must give users an easy way to request edits and deletion (§5b).
  - Required: **encryption at rest** and safeguards (§5c). If there's a breach, we must notify Discord promptly, and notify users as far as the law requires.
  - **Service providers** must agree *in writing* to use the data only for us (§12(a); §10 covers liability). **UNVERIFIED:** that Anthropic's, Supabase's and Vercel's commercial terms/DPAs satisfy this. Check before syncing content.
- **Developer Policy** (effective 2024-07-08):
  - Use API Data only for the stated functionality (#15).
  - **No profiling of users** (#16). Per-member activity leaderboards are a grey zone, so prefer aggregate metrics (counts per channel per day, number of active members).
  - No selling or sharing with ad or data brokers (#17–18).
  - "Do not mine or scrape" (#20). Use the API, synced only for stated features.
  - **No training ML/LLMs on message content** (#21). Inference via Claude isn't training. Anthropic's privacy center says API inputs and outputs aren't used for training by default. The exceptions are feedback or bug reports we explicitly send, or opting in, so don't submit feedback that contains synced Discord content.
  - **No automated messages "for the purpose of maintaining activity"** (#13). Standing automations must be real announcements.
  - No DMs without explicit permission (#5).
  - Provide a way to report issues with the app.
- **Message Content intent:** enable it only if we really store or search content. Activity metrics work without it.
  - Under 10k users it's a toggle. The policy says enable only what the bot "requires to function".
  - Without it, member polls are invisible (`poll` omitted), search is unavailable, and forwarding a message we can't read fails with `160014`.
  - Club memory says Jack reads all app data, so synced Discord content becomes Jack-readable. Disclose that and gate it to officer-only channels.
  - Consider an opt-in channel allow-list: sync only channels the bot can see, and use overwrites to hide private ones.

**Behaviour gotchas:**
- **Channel list changes 2026-11-16:** `GET /guilds/{id}/channels` drops channels the bot can't view. Don't treat a missing channel as deleted without a 404 (`10003`) on `GET /channels/{id}`.
- **Edits and deletes are invisible to `after=` polling.** Re-scan a trailing window (e.g. 7 days) with `after=<snowflake(now-7d)>`. Update rows whose `edited_timestamp` changed; mark ids missing from the scan as deleted.
- **Threads and forums:** messages live in thread channels. Enumerate active and archived threads and sync each thread id like a channel.
- **`allowed_mentions` defaults to parsing `@everyone`/roles/users in normal bot messages.** Always send `{"parse":[]}` unless an officer approved the ping. We also don't grant MENTION_EVERYONE.
- Discord may strip odd characters from content. Sanitize LLM output, and keep content ≤2000 chars (split or use an embed).
- **No gateway means the bot shows "offline"** in the member list. This is cosmetic. **UNVERIFIED:** old docs said a bot must identify on the gateway once before it can send messages. Current Create Message docs have no such note, and the Gateway docs say REST operations can be done over HTTP instead. If the first send still fails, run a one-off local identify script.
- Usernames aren't unique, and `discriminator` is legacy. Key everything on `id`.
- A bot token can't be scoped read-only; least privilege comes from guild/channel permissions. Never pass it to Jack; expose typed tools instead.
- **Two-step approval fits nonces:** the approved action stores a nonce, and a retry with `enforce_nonce` can't double-post.

## 7. How to fake it locally

Build a `DiscordClient` (typed methods R1–R6, W1–W4, OAuth) whose base URLs come from env, plus a **fake HTTP server** (Next route handlers under `/api/dev/fake-discord/...`, or a small `tsx` server) and an in-memory `vi.mock` variant for Vitest. Seed it with a guild, about 6 channels (text, announcement, forum + threads, a hidden one), about 40 members, a few hundred messages, 2 polls (one finalized), roles and events. The fake must reproduce:
1. **Shapes:**
   - Snowflake *strings* generated from timestamps.
   - ISO timestamps with `+00:00`.
   - `messages/search` returning nested arrays.
   - Members with `user` nested.
   - 204 empty bodies for role PUT/DELETE and deletes.
2. **Paging:**
   - Messages newest-first. `limit` defaults to 50 and is clamped to 1–100. `before`/`after`/`around` are exclusive (fake returns 400 if more than one is given; real behaviour **UNVERIFIED**). `after` returns the N oldest messages after the cursor, newest-first.
   - Members ascending by user id with `after` (default limit 1, max 1000).
   - Voters and RSVPs ascending by user id.
   - Search: limit ≤25, offset ≤9975, sometimes short pages.
3. **Intent and permission toggles** (`FAKE_DISCORD_MESSAGE_CONTENT=0|1`, `…_GUILD_MEMBERS=0|1`):
   - Content intent off: blank `content/embeds/attachments/components` and omit `poll`, except on the bot's own messages and messages mentioning it. Search returns 403.
   - Members intent off: list-members returns 403 `50001`.
   - The hidden channel is missing from the channel list. History on it returns `403 50001`. Without READ_MESSAGE_HISTORY, history returns `[]`.
4. **Errors:**
   - `{code,message,errors}` bodies for 10003/10007/10008/10011/10070/50013/50035/30038/520003.
   - Search 202 + `110000` on the first call.
   - Poll `results` sometimes absent.
5. **Rate limits:** every response carries `X-RateLimit-*` headers. A knob forces a 429 with `Retry-After` + `retry_after` + `X-RateLimit-Scope`. Tests check that the client backs off and never retries a 401.
6. **Writes:**
   - Validate the limits in §3: 2000/6000/10 embeds, poll 300/55/10 answers, EXTERNAL needs `location` + end time + `channel_id:null`.
   - `enforce_nonce` dedupes (same message returned).
   - Role changes only below the bot's top role.
   - Events auto-transition by fake clock.
   - Record every write for test assertions.
7. **OAuth:**
   - `/oauth2/authorize` fake page that redirects with `code`, `state` and `iss`.
   - `/oauth2/token` rejects JSON (form only), checks the PKCE verifier and returns `{access_token,token_type:"Bearer",expires_in:604800,refresh_token,scope:"identify"}`.
   - `/users/@me` and `/oauth2/token/revoke`.
8. **Interactions (if built):** a test helper generates an Ed25519 keypair and signs `ts+body`. Tests include PING, a valid command, and a tampered signature (expect 401).

## 8. Sources

- https://docs.discord.com/developers/resources/message (Get Channel Messages, Search Guild Messages, Create/Edit/Delete Message, embed limits, allowed mentions, message types)
- https://docs.discord.com/developers/resources/poll
- https://docs.discord.com/developers/resources/guild (Get Guild, Get Guild Channels, members, roles, role member counts, active threads)
- https://docs.discord.com/developers/resources/channel (channel types, obfuscated channels, archived threads)
- https://docs.discord.com/developers/resources/guild-scheduled-event
- https://docs.discord.com/developers/resources/user
- https://docs.discord.com/developers/resources/application (flags, privacy_policy_url)
- https://docs.discord.com/developers/resources/audit-log (X-Audit-Log-Reason)
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.discord.com/developers/topics/permissions
- https://docs.discord.com/developers/topics/oauth2
- https://docs.discord.com/developers/topics/opcodes-and-status-codes
- https://docs.discord.com/developers/reference (versioning, auth header, User-Agent, snowflakes, signed CDN URLs, uploads)
- https://docs.discord.com/developers/events/gateway (privileged intents, HTTP restrictions, Message Content exceptions)
- https://docs.discord.com/developers/events/webhook-events
- https://docs.discord.com/developers/interactions/overview and /interactions/receiving-and-responding
- https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent
- https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review
- https://docs.discord.com/developers/change-log (2026-03-19 search, 2026-04-14 forwarding, 2026-06-10 intents, 2026-08-12 channel obfuscation, 2026-09-03 uploads, 2026-10-14 `iss`)
- https://discord.com/.well-known/oauth-authorization-server (live: PKCE S256, grant types)
- https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy
- https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service
- https://supabase.com/docs/guides/auth/auth-identity-linking
- https://github.com/supabase/auth/blob/master/internal/api/provider/discord.go (Discord scopes and claim mapping)
- https://docs.github.com/en/code-security/secret-scanning/introduction/supported-secret-scanning-patterns (Discord Bot Token partner pattern)
- https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training

## Checked

Re-checked on 2026-10-22 against Discord's docs, the live OAuth metadata, and the Developer Policy and Terms (fetched through the Zendesk help-center API).

**Confirmed as written:**
- Permission integers, recomputed: `580542407986176`, `580817285925888` and `66560`, plus every bit value.
- Change-log dates: search 03-19, forwarding `160014` 04-14, intents 06-10, channel obfuscation 08-12 (in effect 11-16), uploads 09-03, `iss` 10-14.
- The 10,000-unique-user intent threshold, with a 90-day window to apply and yearly re-application.
- Rate limits: 50 req/s global, the header names, the 429 body, and the invalid-request limit (10,000 per 10 min; `shared` scope exempt). Interaction routes are exempt from the global limit.
- OAuth:
  - token and revoke endpoints accept form bodies only (a live JSON request got a 400);
  - client auth by Basic or form fields;
  - PKCE S256;
  - `authorization_response_iss_parameter_supported: true`;
  - `expires_in: 604800`;
  - revoking a token revokes the whole grant.
- Interactions: Ed25519 over `timestamp + body`, 401 on a bad signature, Discord's deliberate bad-signature checks, PING → 200 `{type:1}`, 3 s to respond, 15-minute tokens, deferred type 5, `PATCH …/messages/@original`.
- Webhook Events: the event list, PING `{type:0}` → 204, 3 s to respond, retries for up to 10 min.
- Messages: history parameters and the empty array without READ_MESSAGE_HISTORY. Search limits, the 202/`110000` response and no `reactions`. Embed and message limits, `enforce_nonce`, and the `allowed_mentions` default.
- Polls: limits, voters endpoint, expire, and the `results` semantics.
- Scheduled events: EXTERNAL rules, the 100-event cap, status transitions, auto-start/complete, RSVP paging.
- Members and roles: list/search limits, role PUT/DELETE → 204, role member counts, the role-hierarchy rule, MANAGE_ROLES needing owner 2FA.
- Every JSON error code cited.
- Application flags 1<<19 / 1<<15 and the stale "under 100 servers" wording.
- Developer Policy items #5, #13, #15–#18, #20, #21 and the reporting requirement (policy effective 2024-07-08).
- Developer Terms §5a–§5c.

**Corrected:**
- The Service Provider "in writing" clause is Developer Terms **§12(a)**, not §10(a). Also added §5(b)'s limits on sharing.
- Message Content exceptions: "replies to its messages" isn't documented. The documented fourth exception is the target of a message context-menu command.
- User-Agent: the docs say requests without one "may be blocked". The Cloudflare attribution was removed.
- Install: with Public Bot off, only the **app owner** can add the bot. "Any server admin" was wrong.
- Uploads: 20 MiB is the *default* per-file limit (higher in boosted servers). The 25 MiB request cap is per Create Message.
- Breach notice to users is required "to the extent required by applicable laws". It isn't unconditional.
- Added the search filter limits (500 channels, 100 authors/mentions, `include_nsfw`, the full `has` list).

**Resolved (no longer UNVERIFIED):**
- Anthropic API inputs aren't used for training by default (Anthropic privacy center).
- Supabase `linkIdentity()` with Discord: confirmed from Supabase Auth's source, not its docs. It requests `email identify` and stores the Discord id as `sub`/`provider_id`.
- Leaked tokens: GitHub reports leaked Discord bot tokens to Discord as a secret-scanning partner. The auto-reset itself is still unconfirmed.

**Still UNVERIFIED:**
- Discord auto-resetting leaked tokens.
- `after=` page semantics: corroborated by discord.py, not by the docs.
- Whether the poll voters endpoint is gated by Message Content.
- Whether managed roles can be assigned.
- The ~5 msgs / 5 s per-channel limit.
- Shared Vercel egress IPs and the invalid-request ban.
- The current App Verification threshold (moot for a private bot).
- Unlimited history depth.
- Whether a gateway identify is needed once before the first send.
- The error search returns without the intent.
- Real behaviour when more than one of `before`/`after`/`around` is passed.
- Whether replies count as mentions.
- Whether the Anthropic, Supabase and Vercel terms satisfy §12(a).
