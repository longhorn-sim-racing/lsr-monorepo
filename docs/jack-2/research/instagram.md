# Instagram: insights and publishing for Jack 2.0

Researched 2026-10-22 from Meta's Instagram Platform docs (`developers.facebook.com/documentation/instagram-platform/...`, latest API version **v26.0**), the Graph API guides, the changelog, and the existing client in `src/lib/instagram.ts`. **UNVERIFIED** marks claims the docs don't state, or where the docs contradict each other.

**Recommendation:**
- Stay on the **Instagram API with Instagram Login** (`graph.instagram.com`), which the feed sync already uses. Insights and publishing both work there, and no Facebook Page is needed.
- Use **two tokens from two Meta apps**:
  - a read token (`instagram_business_basic` + `instagram_business_manage_insights`) for the sync and insights;
  - a publish token (`instagram_business_basic` + `instagram_business_content_publish`) that only the approved-publish path can use.
- Snapshot insights into our own tables on a pg_cron schedule:
  - Account metrics are only kept for 90 days.
  - Story metrics disappear after 24 hours.
  - Data can arrive up to 48 hours late.
- Account-level `profile_views` and `follower_count` are **not** current metrics (see 3a). Use the `followers_count` field and `follows_and_unfollows` instead.

## 1. What we'd use it for

Jack should answer questions like "how did the recruiting post do?" and "is reach up this month?". For that we store daily account totals (reach, accounts engaged, views, interactions, follows and unfollows, follower count) and per-post numbers (reach, likes, comments, saves, shares, views) in Postgres. Jack reads those tables through `jack_readonly` and never calls Instagram itself.

Jack can also draft a post: a single image, a carousel, or a story, built from its deck/graphic renders. The post goes out only after an officer approves it in a proposed change. A Vercel function then runs container → status → `media_publish`. It runs inside 300 s, or in steps driven by pg_cron if a step takes longer.

Token refresh stays in the existing weekly sync. No daemon, no webhooks needed, and no money involved.

## 2. Auth and setup

**Account.** The account must be an Instagram professional account (Business or Creator). @longhorn_sim_racing already is. No Facebook Page is needed: "This API setup does not require a Facebook Page".

**Access level.** Standard Access is enough for accounts we own or manage that have a role on the app. The App Review page marks App Review "Not required" for "My app is only for a business I own or manage". Advanced Access is only for serving accounts we don't own, and it needs App Review and Business Verification.
- Business Verification is only needed "before you can publish your app" (make it Live). The docs don't say outright that Development mode is enough, but `docs/instagram.md` records that today's sync app runs in Development mode.
- The Instagram account assigned on the app "must be public" (create-an-app guide, step 7).

**App type.** The app must be a **Business** app. The dashboard path is Instagram > API setup with Instagram business login > Generate token. A dashboard-generated token is already long-lived (60 days).

**Permissions (Business Login for Instagram scope names; the old `business_*` names stopped working 2025-01-27):**

| Need | Scopes (narrowest) |
|---|---|
| Feed sync + account/media insights | `instagram_business_basic`, `instagram_business_manage_insights` |
| Publish image/carousel/story, read `content_publishing_limit`, container status | `instagram_business_basic`, `instagram_business_content_publish` |
| Not needed | `instagram_business_manage_comments`, `instagram_business_manage_messages` |

- **Two apps, not one.** Scopes are fixed when a token is generated. Today's sync token has only `instagram_business_basic` (docs/instagram.md says so), so it must be regenerated with `manage_insights` added. It stays read-only.
- Put publishing in a **second Meta app** (e.g. "LSR Jack Publisher") so the read token can never publish. It's UNVERIFIED whether generating a second, wider token from the *same* app changes the first token's grant. Two apps avoid the question.
- **Token storage.** Keep tokens in `SystemSetting`, the way the sync does now: the existing `instagram` key, plus a new `instagram_publish` key. Officers paste them in Admin → Instagram. They are never shown again or audited.
- **Token lifetimes.**
  - Authorization code: 1 h, single use. Strip the trailing `#_`.
  - Short-lived token: 1 h.
  - Long-lived token: 60 days.
- **Refresh.** `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
  - The token must be "at least 24 hours old but has not expired", and the user must have granted `instagram_business_basic`.
  - It returns a new token valid "60 days from the date at which they are refreshed".
  - "Tokens not refreshed within 60 days expire and cannot be refreshed." After that, someone regenerates it in the dashboard.
  - No app secret is needed. Refresh both tokens in the existing weekly job.
  - UNVERIFIED: whether the old token string stays valid after a refresh. Always store the new one.
- **OAuth code flow (only if we ever add a "Connect Instagram" button):**
  - `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope=…&state`
  - Then `POST https://api.instagram.com/oauth/access_token` with form fields `client_id, client_secret, grant_type=authorization_code, redirect_uri, code`. It returns `{"data":[{"access_token","user_id","permissions"}]}`.
  - Then `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token` gives `{access_token, token_type:"bearer", expires_in}`. The doc's sample `expires_in` is `5183944` (about 60 days), so read the value instead of assuming exactly 5,184,000.
  - This flow needs the app secret, server-side only. The dashboard paste flow avoids it, so we skip it.

**Env vars:**
- `INSTAGRAM_GRAPH_URL`: already exists. It points the client at the fake.
- No token or secret env vars, because tokens live in `SystemSetting`.
- `INSTAGRAM_APP_SECRET`: only needed if we add the OAuth flow or webhooks. Neither is planned.
- Pin `v26.0` in code for the new calls. Today's client calls unversioned paths. The Graph API versioning guide says "An unversioned call uses the version set in the app dashboard **Upgrade API Version** card under **Settings > Advanced**". It's UNVERIFIED that graph.instagram.com follows the same rule.

**IDs.** `GET /me?fields=user_id,username` returns:
- `id`: the app-scoped user ID;
- `user_id`: the professional account ID (`IG_ID`).

Use `user_id` in `/<IG_ID>/media`, `/<IG_ID>/media_publish`, `/<IG_ID>/insights` and `/<IG_ID>/content_publishing_limit`. The `/me` reference says it "translates to `GET /{user-id}`" and lists creating as "Not supported". UNVERIFIED whether `/me/media` (POST) or `/me/insights` work anyway. The docs' examples use the ID.

## 3. Endpoints we need

All are on `https://graph.instagram.com/v26.0`. Auth is `access_token=` in the query string, or `Authorization: Bearer <token>` (the publishing guide uses the header with a JSON body). Errors use the Graph envelope:
```json
{"error":{"message":"…","type":"OAuthException","code":190,"error_subcode":460,"error_user_title":"…","error_user_msg":"…","fbtrace_id":"EJplcsCHuLu"}}
```

Cursor pagination returns `paging.cursors.before/after`, plus `next` and `previous` URLs. A missing `next` means the last page, and a page can be short before the end. That's the general Graph shape, and the existing sync relies on `/me/media`.

### 3a. Account insights: `GET /<IG_ID>/insights`
Scopes: basic + manage_insights.

| Param | Notes |
|---|---|
| `metric` | Required, comma-separated |
| `period` | Required. Only `day` and `lifetime` appear in the metrics table |
| `metric_type` | `total_value` or `time_series` |
| `since`, `until` | Unix seconds, inclusive. With neither, the API looks back 24 h. The current page states no maximum range (older docs said 30 days), so query one day at a time |
| `breakdown` | Only returned with `total_value`. Request breakdown metrics one at a time: an unsupported breakdown returns `"An unknown error has occurred."` |
| `timeframe` | Demographics only: `this_week` / `this_month`. `last_14/30/90_days` and `prev_month` were removed in v20 |

Metrics we'd use:

| Metric | Period | metric_type | Breakdowns |
|---|---|---|---|
| `reach` | day | total_value, time_series | media_product_type, follow_type |
| `accounts_engaged` | day | total_value | none |
| `views` ("in development") | day | total_value | follow_type (the doc's table says `follower_type`), media_product_type |
| `total_interactions` | day | total_value | media_product_type |
| `likes`, `comments`, `saves`, `shares` | day | total_value | media_product_type |
| `follows_and_unfollows` | day | total_value | follow_type |
| `profile_links_taps` | day | total_value | contact_button_type |
| `replies`, `reposts` | day | total_value | none |
| `follower_demographics`, `engaged_audience_demographics` | lifetime | total_value + `timeframe` | age, city, country, gender (top 45 only) |

Breakdown values:
- `follow_type`: FOLLOWER / NON_FOLLOWER / UNKNOWN.
- `media_product_type`: AD / POST / CAROUSEL_CONTAINER / REEL / STORY.

**What changed from the goals list:**
- **`profile_views`:** the changelog entry of 2024-10-02 says the `profile_views` (and `website_clicks`, `email_contacts`, …) "time series metrics will no longer be supported", for v21.0+ and for all versions on 2025-01-08. It's gone from the metrics table. Use the media-level `profile_visits` (posts and stories), summed, plus account-level `profile_links_taps`. The entry names only the time-series form, so it's UNVERIFIED whether `profile_views` with `total_value` still answers.
- **`follower_count`:** it's no longer in the metrics table. It appears only in the limitations note (not available with fewer than 100 followers), and since 2020 it has returned at most 30 days of data (changelog 2020-11-10). Snapshot `GET /me?fields=followers_count,follows_count,media_count` daily instead, and use `follows_and_unfollows` for gains and losses. UNVERIFIED whether `follower_count` with `period=day` still answers.
- **`impressions`:** deprecated for all versions 2025-04-21. Use `views`.

Request:
```
GET /v26.0/17841400000000000/insights?metric=reach,accounts_engaged,views,total_interactions,follows_and_unfollows&period=day&metric_type=total_value&since=1761022800&until=1761109200&access_token=IG…
```
Response (trimmed; with a breakdown, `total_value` also carries `breakdowns:[{dimension_keys:["follow_type"],results:[{dimension_values:["FOLLOWER"],value:120}]}]`):
```json
{"data":[
  {"name":"reach","period":"day","title":"Accounts reached","description":"…","total_value":{"value":224},"id":"17841400000000000/insights/reach/day"},
  {"name":"accounts_engaged","period":"day","title":"Accounts engaged","total_value":{"value":31},"id":"17841400000000000/insights/accounts_engaged/day"}
 ],
 "paging":{"previous":"https://graph…","next":"https://graph…"}}
```
A `time_series` reach item carries `values:[{"value":12,"end_time":"2026-10-21T07:00:00+0000"}]` instead of `total_value`. That shape comes from older docs and is UNVERIFIED for v26.

**Errors and edge cases:**
- Missing data comes back as an **empty `data` array, not 0**.
- Accounts under 100 followers get no `follows_and_unfollows`, `follower_count` or `online_followers`.
- 190 means the token is dead.
- 10 or 200-299 means a permission is missing (the scope wasn't granted).
- 100 means an invalid metric or parameter.
- 4, 17 or 80002 means throttled (section 5).

### 3b. Media list: `GET /me/media`, then each post's ID
- Already used: `fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{…}&limit=24`.
- Add `like_count,comments_count` (basic scope).
- Stories aren't included. `GET /<IG_ID>/stories` is documented for Facebook Login only, so it's UNVERIFIED on graph.instagram.com. We know the IDs of stories we publish ourselves; stories posted from the phone may not be visible to us.
- `like_count` is left out when the owner hides like counts.
- `media_url` is optional (licensed-audio videos; changelog 2026-07-30).
- The IG Media reference marks `caption` and `media_product_type` "Facebook Login only". Yet the live sync reads `caption` fine, and the publishing guide says to read `media_product_type` to spot stories. Treat `media_product_type` as UNVERIFIED.

### 3c. Media insights: `GET /<MEDIA_ID>/insights?metric=…`
- Scopes: basic + manage_insights.
- `period` is always `lifetime`. The reference also lists `day`, `week`, `days_28`, `month` and `total_over_range` as accepted values, but its response section says the period is always `lifetime`; send `lifetime` or omit it.
- Breakdowns: `action_type` (for `profile_activity`) and `story_navigation_action_type` (for `navigation`).

| Media | Metrics to request |
|---|---|
| Image / carousel (FEED) | `reach,likes,comments,saved,shares,views,total_interactions,profile_visits,follows` (+ `profile_activity`, `reposts`) |
| Story | `reach,views,shares,replies,total_interactions,profile_visits,follows,navigation,link_clicks` |
| Reel | `reach,likes,comments,saved,shares,views,total_interactions,ig_reels_avg_watch_time` |

The media-level metric is **`saved`**, but the account-level one is **`saves`**.

Don't use these:
- `impressions` (deprecated for media after 2024-07-02);
- `plays`, `clips_replays_count`, `video_views` (removed);
- `total_likes`, `total_comments`, `total_views` (Facebook Login only).

Request: `GET /v26.0/18012345678901234/insights?metric=reach,likes,comments,saved,shares,views&access_token=IG…`
```json
{"data":[
  {"name":"reach","period":"lifetime","values":[{"value":812}],"title":"Accounts reached","description":"…","id":"18012345678901234/insights/reach/lifetime"},
  {"name":"saved","period":"lifetime","values":[{"value":14}],"title":"Saved","id":"18012345678901234/insights/saved/lifetime"}
]}
```

**Errors and edge cases:**
- **Carousel children have no insights.** Query the album ID.
- **Story metrics live 24 h only** (longer if the story is added to a highlight). Insights webhooks (`story_insights`) are Facebook Login only, so we have to poll.
- `(#10) Not enough viewers for the media to show insights` (code 10) means a story metric is under 5.
- An unsupported metric for that media type returns error 100. The exact message is UNVERIFIED.
- An unsupported breakdown returns "An unknown error has occurred."
- Data can be up to 48 h late, and media metrics are kept up to 2 years.
- `likes`, `comments`, `views` and `total_interactions` exclude ad interactions.

### 3d. Create a container: `POST /<IG_ID>/media`
Scopes: basic + content_publish. JSON body or query params.

| Kind | Body |
|---|---|
| Single image | `{"image_url":"https://…/a.jpg","caption":"…","alt_text":"…"}` |
| Carousel child (×2–20) | `{"image_url":"…","is_carousel_item":true}` (no caption, no location) |
| Carousel parent | `{"media_type":"CAROUSEL","children":"<C1>,<C2>,<C3>","caption":"…"}` |
| Story | `{"image_url":"…","media_type":"STORIES"}` (no alt_text, no collaborators) |

Optional fields:
- `is_ai_generated: true`. On a carousel, set it on the parent only.
- `user_tags: [{username,x,y}]`. x and y are required for images and optional for stories.
- `location_id`.
- `collaborators`: up to 3, and not for stories.

Response: `{"id":"17889455560051444"}` (the container ID).

**Image requirements:**
- JPEG only. MPO and JPS are rejected.
- At most 8 MB (error 36000/2207004).
- Feed aspect ratio must be **4:5 to 1.91:1** (error 36003/2207009).
- Width 320 to 1440 px; Meta scales outside that.
- sRGB; other color spaces are converted.
- Stories: JPEG, 8 MB, 9:16 recommended (1080×1920).
- Carousel images are all cropped to the **first image's** ratio (1:1 by default).
- Captions: at most 2,200 characters, 30 hashtags and 20 @-tags (error 36004/2207010).
- **The URL must be public when Meta fetches it**: "We cURL media used in publishing attempts". Our Jack renders sit in a private Blob store, so copy the render to a public JPEG first. The Cloudinary account we already have can convert with `f_jpg`. Fetch failures return 9004/2207052, and timeouts -2/2207003.
- The `ig-user/media` reference also requires "URLs that contain only US ASCII characters, or the request will fail". Keep public image URLs ASCII-only.
- The image specs, the 400-container cap and the sticker rule come from the `ig-user/media` reference, which is written for Facebook Login (`graph.facebook.com`). The Instagram Login publishing guide links to it, so we assume they apply on graph.instagram.com too.
- API stories can't have link, poll or location stickers.

### 3e. Container status: `GET /<CONTAINER_ID>?fields=status_code,status`
Response: `{"status_code":"FINISHED","id":"17889615691921648"}`.

| `status_code` | Meaning |
|---|---|
| `IN_PROGRESS` | Still processing |
| `FINISHED` | Ready to publish |
| `PUBLISHED` | Already published |
| `ERROR` | Failed; `status` holds a subcode |
| `EXPIRED` | Not published within 24 h |

Meta's advice is to poll "once per minute, for no more than 5 minutes". Images are usually ready quickly, but that timing is UNVERIFIED, so cap any in-request wait at about 60 s and hand the rest to a pg_cron retry.

### 3f. Publish: `POST /<IG_ID>/media_publish` with `{"creation_id":"<CONTAINER_ID>"}`
- Response: `{"id":"17920238422030506"}` (the IG media ID). It may add `"config_issue":"CAPTION_NOT_ATTACHED"|"USER_TAGGING_FAILURE"` or `"caption_add_on_attachment_status":"POLL_CREATION_FAILURE"|"PROMPT_CREATION_FAILURE"`. Either is a partial success and the post is live: "treat them as a signal to reconcile rather than as an error".
- Errors:
  - 9007/2207027: not ready. Poll again.
  - 24/2207008: the container doesn't exist or expired. Retry once or twice over 30 s to 2 min, then re-create.
  - -2/2207020: expired.
  - 9/2207042: daily publish limit reached.
  - 25/2207050: account restricted.
  - 4/2207051: flagged as spam.
  - -1/2207001 and -1/2207032: server error. Retry.
- **Not idempotent.** If the call times out, read the container's `status_code`. If it says `PUBLISHED`, don't publish again.

### 3g. Quota: `GET /<IG_ID>/content_publishing_limit?fields=quota_usage,config`
```json
{"data":[{"quota_usage":2,"config":{"quota_total":50,"quota_duration":86400}}]}
```
`since` is optional and must be a Unix time within the last 24 h. Check the quota before the officer approves a post, and show it to them.

### 3h. Profile snapshot: `GET /me?fields=user_id,username,account_type,followers_count,follows_count,media_count`
- `account_type` is `Business` or `Media_Creator`.
- Used for the daily follower-count row.

## 4. Webhooks

We don't need any. Instagram Login supports only comments/mentions/messaging fields. `story_insights` is Facebook Login only, and the insights docs say "Insights webhooks are not supported for Instagram Login". Receiving webhooks would also need the app Live with Advanced Access and Business Verification.

For reference, if we ever add comments or mentions:
- Verify with a GET carrying `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`, and echo back the challenge.
- Payloads carry `X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body, App Secret)>`. UNVERIFIED whether that's the Instagram app secret or the Meta app secret for Instagram Login.
- Subscribe with `POST /<IG_ID>/subscribed_apps?subscribed_fields=comments`.
- With Instagram Login, `mentions` arrive inside the `comments` notification. Subscribing needs `instagram_business_manage_comments`.
- Failed deliveries are retried for up to 36 h. Batches hold up to 1,000 updates, but batching "cannot be guaranteed", so handle each one and dedupe.

## 5. Rate limits, quotas and retention

**Rate limits and quotas:**
- **API calls (Business Use Case):** "Calls within 24 hours = 4800 * Number of Impressions", per app and account pair, over a rolling 24 h window.
  - Throttling returns code 80002 (Instagram) or 4/17/613. Read `X-Business-Use-Case-Usage`: `call_count`, `total_time` and `total_cputime` are percentages of the allowance, not counts; `estimated_time_to_regain_access` is in minutes; `type` is `instagram`.
  - UNVERIFIED that graph.instagram.com sends that header.
  - Our load is about 30 calls a day, so this is a non-issue unless the account gets almost no impressions.
- **Publishing:** the docs conflict.
  - The guide's Rate Limit section says "100 API-published posts within a 24-hour moving period".
  - The carousel section, the `media_publish` reference and `content_publishing_limit` say **50** ("currently `50`").
  - **Trust `config.quota_total` at runtime.**
  - A carousel counts as 1 post. UNVERIFIED whether stories count toward the quota.
- **Containers:** at most "400 containers within a rolling 24 hour period", and each expires after 24 h. Create containers only *after* approval, never at draft time.
- **Plan:** there's no paid tier. Standard Access covers our own account.

**Retention:**
- Account metrics: "stored for up to 90 days".
- Media metrics: up to 2 years.
- Stories: 24 h.
- `online_followers`: last 30 days.
- Demographics: top 45 per dimension.
- Data can be 48 h late.

**Plan for snapshots:**
- **Daily pg_cron job:** fetch the account `day` totals for each of the last 3 days and upsert them, which covers the 48 h lag. Fetch the profile snapshot. Fetch insights for every post younger than 30 days.
- **Hourly job while a story we published is under 24 h old:** fetch its story metrics, keeping the last value.

## 6. Gotchas, policy and privacy

**Gotchas:**
- **Deprecated metric names are the main trap:** `impressions`, `profile_views`, `plays`, `video_views`, `website_clicks`, `email_contacts` and similar. Use exactly the tables above.
- `saved` (media) vs `saves` (account).
- An empty `data` array means "no data", not zero. Store it as NULL.
- Carousel children have no insights.
- **Docs conflicts to code around:**
  - 50 vs 100 posts a day.
  - Carousels: the reference allows 20 items, but the 2207028 error text still says "2 … no more than 10". Allow 2–20, and surface the error if Meta rejects more than 10.
  - `caption` and `media_product_type` are marked Facebook-Login-only.
- **Prepare images first.** PNG renders must be converted to JPEG, sRGB, 1080 px wide. Feed posts at 4:5 (1080×1350) are the safest ratio; stories are 1080×1920. Every image in a carousel should share the first image's ratio.
- **Tokens:**
  - A password change on the club Instagram kills both tokens (190/460), and so does removing the app from the account.
  - The refresh needs a token over 24 h old, so don't refresh right after pasting.
  - Never pass the publish token to Jack's tools or to the LLM. Only the server-side publish action reads `SystemSetting.instagram_publish`.
- **Publishing:**
  - API stories have no link stickers, so put the link in the post or bio.
  - Shopping tags and filters aren't supported.
- **Policy:**
  - Developer Policies §1.7: "Obtain consent from people before publishing content or taking any other action on their behalf". Officer approval is the consent, so keep publishing behind a proposed change and write an `AuditLog` entry.
  - §1.4: "Don't … spam", so keep a daily cap well under quota.
  - §6.2: "Don't use the Instagram Platform to simply display User Content, import or backup content", or manage Instagram relationships, "without our prior permission". The rule has no exception for an account's own posts; Meta's prior permission is the only exception. Our feed mirror shows only our own posts on our own site, and that's a common use. But it's UNVERIFIED as a compliance conclusion, so flag it for Gray along with §5.a.i below.
  - Platform Terms §3.d.i: delete Platform Data once it's "no longer necessary for a legitimate business purpose".
  - Platform Terms §5.a.i: a Service Provider that processes Platform Data must agree in writing to comply. Sending our insights to the Claude API makes Anthropic a processor under that clause. That's UNVERIFIED as a compliance conclusion, so flag it for Gray. The data is aggregate counts about our own account, with no personal data.
  - Platform Terms §6.a.iv: "You must protect and not transfer, share, or solicit … access tokens, or app secrets".
- **AI label:** the docs describe `is_ai_generated=true` only as "a self-disclosure of AI usage in the post". It's UNVERIFIED that it shows Instagram's visible "AI info" label. Whether Jack-designed graphics need it is a Media/board call. Default it off, and let the officer tick it.
- **Privacy:** account insights are aggregates. Demographics (city, age, gender) are aggregate too, but it's best not to fetch them unless asked. No follower identities are available through this API.

## 7. How to fake it locally

Extend the stand-in at `INSTAGRAM_GRAPH_URL`, which already serves `/me`, `/me/media` and `/refresh_access_token`. The fake must reproduce:

**Requests and errors:**
- An optional `/vNN.N` path prefix.
- Auth by `access_token` query param **or** `Authorization: Bearer`.
- Bodies as JSON or form/query params.
- The Graph error envelope above. Return HTTP 400 for errors. Meta's publishing error-code table lists HTTP 400 for every publishing error. For other codes (190, 10, 100, throttling) the HTTP status is UNVERIFIED; 400 is the existing client's assumption.

**Tokens:**
- Tokens have scopes, `issued_at` and `expires_at`. A missing scope returns code 10.
- Expired tokens return 190 (subcode 463), and a "password changed" switch returns 190/460.
- `refresh_access_token` refuses tokens under 24 h old or expired, and returns `{access_token,token_type:"bearer",expires_in:5184000}`.

**Profile:** `/me` returns `id` ≠ `user_id`, plus `followers_count`, `follows_count`, `media_count` and `account_type`.

**Account insights:**
- Validate metric names against the 3a table. Removed names (`impressions`, `profile_views`, `follower_count`) return error 100.
- Enforce `period`/`metric_type` support, and return "An unknown error has occurred." for a bad breakdown combination.
- Return `total_value`, `breakdowns` or `values[]` shapes as shown, and `paging`.
- Return an empty `data` array for no-data days and under-100-follower accounts.
- A fake clock with 48 h-late backfill, so upserts get tested.

**Media insights:**
- Per-type metric sets (FEED / STORY / REELS). The wrong set returns error 100.
- Album children return an error.
- Stories over 24 h old return empty data. That behavior is UNVERIFIED.
- Story values under 5 return `(#10) Not enough viewers…`.

**Publishing:**
- `POST /media` actually fetches `image_url`:
  - unreachable → 9004/2207052;
  - not JPEG by magic bytes → 36001/2207005;
  - over 8 MB → 36000/2207004;
  - feed ratio outside 4:5–1.91:1 (read the JPEG SOF dimensions) → 36003/2207009;
  - caption over 2,200 characters, 30 # or 20 @ → 36004/2207010.
- Carousel parent: 2–20 children, each `is_carousel_item` and unused.
- Container state machine: `IN_PROGRESS` → `FINISHED` after N polls or seconds, then `PUBLISHED`, `EXPIRED` after 24 h of fake clock, and an injectable `ERROR`.
- Cap of 400 containers per rolling 24 h.
- `media_publish`:
  - not finished → 9007/2207027;
  - expired or unknown → 24/2207008;
  - over quota → 9/2207042;
  - publishing the same container twice → error (code UNVERIFIED).
  - On success it returns a new media ID, and the post appears in `/me/media`. Stories appear only in insights.
- `content_publishing_limit` tracks `quota_usage` against a configurable `quota_total` (default 50) over a rolling 86,400 s.

**Fault injection:** codes 1 and 2 (transient), 4, 17 and 80002 with an `X-Business-Use-Case-Usage` header, 25/2207050 (restricted), and a publish timeout where the container still flips to `PUBLISHED`. That last one tests the idempotency check.

## 8. Sources
All under `https://developers.facebook.com`. Pages are under `/documentation/instagram-platform/` unless the path shows otherwise.
- Index and setup: `/llms.txt`, `/instagram-api-with-instagram-login`, `/instagram-api-with-instagram-login/business-login`, `/docs/instagram-platform/instagram-api-with-instagram-login/get-started`, `/overview`
- Tokens and profile: `/reference/access_token`, `/docs/instagram-platform/reference/refresh_access_token`, `/reference/me`
- Publishing: `/content-publishing` (plus the `/docs/` copy), `/instagram-graph-api/reference/ig-user/media` (plus the `/docs/` copy), `.../ig-user/media_publish`, `.../ig-user/content_publishing_limit`, `.../ig-user/stories`, `/instagram-graph-api/reference/ig-container`, `/instagram-graph-api/reference/error-codes`
- Insights: `/reference/instagram-media`, `/insights` (plus the `/docs/` copy), `/api-reference/instagram-user/insights` (plus `.md`), `/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights`, `/reference/instagram-media/insights`
- Changes and webhooks: `/changelog`, `/webhooks`, `/webhooks/setup`, `/webhooks/fields`
- Graph API, policy and terms: `/docs/graph-api/overview/rate-limiting`, `/docs/graph-api/results`, `/docs/graph-api/guides/error-handling`, `/docs/graph-api/guides/versioning`, `/devpolicy/`, `/terms/`
- Access and app setup (added in the check): `/create-an-instagram-app`, `/docs/instagram-platform/app-review`

## Checked

Checked 2026-10-22 against Meta's live docs (the pages above, fetched directly).

**Verified as written:**
- Hosts, methods and paths for `/me`, `/<IG_ID>/insights`, `/<MEDIA_ID>/insights`, `POST /<IG_ID>/media`, container status, `media_publish`, `content_publishing_limit`, `refresh_access_token`, and the OAuth authorize, code-exchange and long-lived-exchange endpoints.
- v26.0 is the latest version.
- Scopes: `instagram_business_basic` plus `manage_insights` or `content_publish`. The `business_*` names were deprecated 2025-01-27.
- No Facebook Page needed; app must be a Business app; dashboard tokens last 60 days. Code: 1 h, single use, strip `#_`. Refresh rules: token at least 24 h old, `instagram_business_basic`, "60 days from the date at which they are refreshed".
- `id` vs `user_id`, and `account_type` values `Business` / `Media_Creator`.
- The account metric table, breakdowns, `timeframe` changes, empty-data-not-0, 48 h delay, top 45, 90-day account retention, 2-year media retention.
- Per-type media metrics, the `saved` vs `saves` split, Facebook-Login-only `total_*`, the 24 h story window, the `(#10)` under-5-viewers error, and no insights webhooks for Instagram Login.
- Deprecation dates for `impressions`, `plays`, `clips_replays_count` and `video_views`, and the 2026-07-30 note that `media_url` is optional.
- Image specs (JPEG, 8 MB, 4:5 to 1.91:1, 320–1440 px, sRGB), caption limits, 20-item carousels, carousel crop to the first image, and story limits (no stickers, no alt_text or collaborators).
- 400 containers per 24 h, 24 h container expiry, every publishing error code/subcode pair listed, the five `status_code` values, and the "once per minute, for no more than 5 minutes" polling advice.
- The 50-vs-100 conflict is real: the guide's Rate Limit section says 100; the carousel section, `media_publish` and `content_publishing_limit` say 50.
- Rate limit "4800 * Number of Impressions" per app and app-user pair over a rolling 24 h, and code 80002.
- Webhook verification, the `X-Hub-Signature-256` HMAC-SHA256, the `subscribed_apps` call, the Live + Advanced Access + Business Verification requirement, the field matrix, 36 h retries and 1,000-update batches.
- Developer Policy §1.7, §1.4 and §6.2 quotes, and Platform Terms on data deletion, Service Providers and tokens.

**Corrected:**
- `profile_views`: the 2024-10-02 changelog deprecates its *time series* form only. The note now says so.
- `follower_count`: added the 2020 changelog cap (at most 30 days of data) and listed it among the under-100-follower gaps.
- `since`/`until`: the current page states no maximum range and the range is inclusive. This was marked UNVERIFIED and is now resolved.
- Unversioned calls: per the Graph API versioning guide, they use the app's dashboard default version. Resolved for graph.facebook.com; unconfirmed for graph.instagram.com.
- `expires_in` sample is `5183944`, not a fixed `5184000`.
- `X-Business-Use-Case-Usage` `call_count`, `total_time` and `total_cputime` are percentages, not counts.
- `media_publish` can also return `caption_add_on_attachment_status`.
- Media insights `period`: noted the reference's conflicting list of accepted values.
- Access: added that the assigned Instagram account "must be public", and that Business Verification is only needed to publish (make Live) the app.
- Added the US-ASCII image URL requirement, and that the image specs come from the Facebook Login `ig-user/media` reference.
- Webhooks: Instagram Login mentions arrive in the `comments` notification, and batching "cannot be guaranteed".
- Policy §6.2: the rule has no own-content exception (only "without our prior permission"), so the own-posts reasoning is now flagged as unverified. Terms section numbers tightened to §3.d.i and §5.a.i.
- `is_ai_generated`: the docs say only "self-disclosure of AI usage". The claim that it adds the visible "AI info" label is now UNVERIFIED.
- HTTP status: the publishing error table lists HTTP 400 for every publishing error. Partly resolved.

**Still unverified (the docs don't say):**
- Whether a second, wider token from the same app changes the first token's grant.
- Whether the old token stays valid after a refresh.
- Whether `/me/media` POST and `/me/insights` work.
- Whether `profile_views` (total_value) or `follower_count` still answer.
- The `time_series` response shape for v26.
- Whether `/stories` and `media_product_type` work on graph.instagram.com.
- The error message for an unsupported media metric.
- Image container processing time.
- Which app secret signs Instagram Login webhooks.
- Whether graph.instagram.com sends `X-Business-Use-Case-Usage`.
- Whether stories count toward the publish quota.
- The error code for publishing a container twice.
- Story insights after 24 h.
- HTTP status for non-publishing error codes.
- That Development mode is enough. The docs don't say this outright; only the repo's working sync shows it.
- The Platform Terms §5.a.i and Developer Policy §6.2 compliance calls, which are flagged for Gray.
