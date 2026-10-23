# Vercel Web Analytics (and Speed Insights): research spec

Researched 2026-10-22 from Vercel's own docs and OpenAPI spec, plus a few read-only live probes through the Vercel MCP (noted where used). Anything not confirmed is marked **UNVERIFIED**.

**Bottom line:** a public, documented REST API for Web Analytics exists. It went GA on 2026-05-18: `GET https://api.vercel.com/v1/query/web-analytics/visits/{count|aggregate}`, with a Bearer access token. It returns `pageviews` and `visitors`, grouped by up to two of: time bucket, `requestPath`, `route`, `referrerHostname`, `country`, `deviceType`, `browserName`, `osName` and a few more. On Hobby the API only sees **1 month** of data. **Speed Insights has no documented public query API.**

## 1. What we'd use it for

We want site traffic for (a) an admin dashboard card ("last 7/30 days: views, visitors, top pages, top referrers, countries, mobile vs desktop") and (b) a read-only Jack tool, so officers can ask things like "how did /apply do after the GM?" or "where is recruiting traffic coming from?". The site already sends page views through `<Analytics />` (`@vercel/analytics` ^1.5.0, in `apps/platform/src/app/layout.tsx`). Because Hobby keeps only one month, the plan is a **daily snapshot job**: Supabase pg_cron + pg_net calls a Vercel function, which calls the API about 5 times and upserts the results into Postgres. That builds history beyond 30 days and lets Jack read our own table instead of holding the Vercel token. For "today/live" numbers, the admin card can call the API directly, cached for 1 hour. This needs no always-on process, and the token stays read-only in practice (see §2 caveat).

## 2. Auth and setup

**Token type:** a Vercel Access Token (personal-style, prefix `vcp_`), sent as `Authorization: Bearer <token>`. It is created at https://vercel.com/account/tokens. There is no OAuth flow for this use.

**Narrowest scope:** a **Project-scoped token**, available since 2026-07-30. When creating it, pick Scope → the team that owns the project → the project (`lsr-monorepo`). Choosing "All Projects" makes a team token instead. A project-scoped token:
- is denied for other projects and for team-level and user-level resources.
- does not need `teamId` or `slug`, because Vercel infers both from the token.
- is **read AND write** on that project. Vercel has **no read-only token option** (docs and the changelog only describe read and write, and the create-token API body `POST /v3/user/tokens` takes only `name`, `expiresAt` and `projectId`, with no permission field). In theory it can touch deployments, domains and env vars of the prod project. **UNVERIFIED:** whether it can read decrypted env values. The docs give no carve-out (it can "read and write resources belonging to" the project, and env vars are project resources), so assume it can. Treat it as a high-value secret: keep it server-only and never put it in Jack's context. Wrap it in a client that only allows the two GET paths below.
- cannot mint other tokens (creating tokens through the CLI or API requires a full-account token).

**Who can create it:** only a member of the team that owns the project (with 2FA turned on if that team enforces it). `apps/platform/.vercel/project.json` (gitignored) has the `projectId` (`prj_…`) and `orgId` (`team_…`). On 2026-10-22, a live probe with Gray's current Vercel login (`graymarshall`) got `403 forbidden`: "Trying to access resource under scope "admins-projects-…"". So the LSR project sits in a separate Hobby team that this login can't see, and **the token must be created while logged in as the account that owns the LSR Hobby team.**

**Lifetime:** you pick an expiration when creating the token. The token stops working after that date. The KB says expired tokens "stop working even if you forget to revoke it." **UNVERIFIED:** the exact list of dashboard choices. Vercel's current docs only say "choose an expiration". The create-token API makes `expiresAt` optional, so non-expiring tokens exist at least through the API, and third-party setup guides (e.g. Oneleet) describe a "No Expiration" option in the dashboard drop-down. An older Vercel page reportedly said "1 day to 1 year". Check the drop-down when creating the token. There is no refresh flow: when the token expires, make a new one. Plan: 1-year expiry, a calendar reminder, and have the job surface 401/403 as "analytics token expired or wrong scope" in the admin UI.

**Prereqs:** Web Analytics must be enabled on the project. A project without it returns `404 not_found "Web Analytics not found."`, confirmed live on 2026-10-22 against an unrelated project.

**Env vars** (Vercel Production only, marked Sensitive; plus `.env.local` pointing at the fake):
- `WEB_ANALYTICS_TOKEN`: the project-scoped `vcp_…` token.
- `WEB_ANALYTICS_PROJECT_ID`: `prj_…`. The project name also works, per the API docs.
- `WEB_ANALYTICS_TEAM_ID`: optional. Only needed if we ever fall back to a full-account token.
- `WEB_ANALYTICS_API_BASE`: defaults to `https://api.vercel.com`. Local dev and tests point it at the fake.
- `CRON_SECRET` (or the scheduler's shared secret): authenticates the pg_net call to the snapshot route.

Avoid the bare name `VERCEL_TOKEN`, because the Vercel CLI and other tooling use it.

## 3. Endpoints we need

Base URL: `https://api.vercel.com`. All endpoints are `GET` with query-string params. Add `teamId=` or `slug=` only with a full-account token. (The Web Analytics guide's examples always pass `teamId` because they assume a full-account token. The access-token docs say team- and project-scoped tokens infer the team and project, so those params can be omitted.) Dates (`since`/`until`) are **ms timestamps or any valid Date string** (`2026-10-01` or ISO). Both are **inclusive** and are "adjusted according to the desired time granularity". There is **no pagination**: grouped endpoints return the top `limit` rows and fold the rest into an `"Others"` group.

Dimensions for `by` and `filter`: `country, deviceType, environment, requestPath, referrerHostname, osName, browserName, route, utmSource, utmMedium, utmCampaign, utmContent, utmTerm`, plus `flags` / `flags/<name>`. Time granularities (only in `by`): `hour, day, week, month, year`. `requestHostname` is **not** allowed in `by` or `filter` (it is missing from both OpenAPI enums, even though the response schema lists it). Filtering on it returns error code `bad_request` with a message containing `Unsupported subject "requestHostname"` plus the allowed subjects (community report, 2026-07-17; the post doesn't show the HTTP status, presumably 400; still an open feature request with no staff reply). Filters use OData: `eq, ne, in, and, or, not`, parentheses, `startswith(...)`, max 2048 chars. Quote strings with single quotes and URL-encode the whole expression.

### 3a. Aggregate page views (the workhorse)
`GET /v1/query/web-analytics/visits/aggregate` (operationId `aggregatePageviews`)

| Param | Req | Notes |
|---|---|---|
| `projectId` | yes | id or name |
| `by` | yes | array, 1–2 unique items, at most one time granularity. Encoding: **repeat the key** (`by=day&by=country`). The OpenAPI parameter declares no `style`/`explode`, so the OpenAPI defaults (form, explode=true) apply, which means repeated keys; Vercel's MCP→CLI fallback also says to send arrays this way. The generated reference example's `by=[]` is filler. A comma-joined value is **UNVERIFIED** |
| `since`, `until` | yes | inclusive; limited to the plan's reporting window (Hobby: 1 month) |
| `limit` | no | int 1–100, default 10; the remainder is grouped into "Others" |
| `filter` | no | OData; **defaults to production only** (add `environment eq 'preview'` to see previews) |

Example (top pages, last 7 days):
```bash
curl --get "https://api.vercel.com/v1/query/web-analytics/visits/aggregate" \
  -H "Authorization: Bearer $WEB_ANALYTICS_TOKEN" \
  --data-urlencode "projectId=$WEB_ANALYTICS_PROJECT_ID" \
  --data-urlencode "since=2026-10-15" --data-urlencode "until=2026-10-21" \
  --data-urlencode "by=requestPath" --data-urlencode "limit=10"
```
Trimmed response (shape from the official guide; values are made up):
```json
{
  "version": 1,
  "query": { "since": "2026-10-15", "until": "2026-10-21", "groupBy": ["requestPath"], "limit": 10 },
  "data": [
    { "requestPath": "/", "pageviews": 640, "visitors": 410 },
    { "requestPath": "/apply", "pageviews": 180, "visitors": 150 }
  ]
}
```
Time series (`by=day`, optionally with `filter=requestPath eq '/apply'`). Rows carry `timestamp` (ISO, bucket start, UTC):
```json
{ "version": 1,
  "query": { "since": "2026-10-15", "until": "2026-10-21", "groupBy": ["day"], "filter": "requestPath eq '/apply'" },
  "data": [ { "timestamp": "2026-10-15T00:00:00.000Z", "pageviews": 220, "visitors": 180 } ] }
```
The other queries we need use the same call with `by=referrerHostname`, `by=country`, `by=deviceType`, `by=route` (rolls `/events/[slug]` up into one row) or `by=day&by=country`.

Notes on the shape:
- The generated reference page shows every dimension field on every row, plus `version` as a string `"123"`. That is auto-generated filler (the schema types `version` as a number). The JSON Schema's `data` is a `oneOf`: a time-series row shape that only requires `timestamp`, and a dimension row shape that "requires" every string dimension field and puts the metrics in `additionalProperties: number|null`. `query` requires `limit, since, until`. The guide examples (rows with only the grouped dims + `pageviews` + `visitors`, `version: 1`) are the shape to code against.
- **UNVERIFIED:**
  - exactly how the "Others" row is represented (dimension value `"Others"`?).
  - row ordering (assumed `pageviews` desc).
  - how a two-dimension (`day` + `country`) result is laid out (assumed flat rows carrying both `timestamp` and `country`).
  - the casing of `deviceType` values (docs mention mobile/tablet/desktop).
  - whether `country` is ISO-3166 alpha-2 (the guide shows `"US"` and `"DE"`).

  Log the first real response and adjust the fake.

### 3b. Count page views
`GET /v1/query/web-analytics/visits/count` (operationId `countPageviews`). Params: `projectId` (req), `since`/`until` (optional), `filter` (optional), `teamId`/`slug`. **Production only.** Without dates it counts "since Web Analytics was enabled". **UNVERIFIED:** whether that is still capped by the 1-month Hobby window. The guide says aggregate endpoints "query data within your plan's reporting window" but says only that count endpoints "query production data", which hints that count is not capped. Don't rely on it either way. (The Vercel MCP's wrapper says `since` and `until` must be passed together; do the same.)
```json
{ "version": 1, "query": { "filter": "requestPath eq '/apply'" }, "data": { "pageviews": 1250, "visitors": 980 } }
```
This fits headline tiles ("views this week") and Jack's "how many people saw X" questions.

### 3c. Not needed on Hobby
`/v1/query/web-analytics/events/{count|aggregate}` covers custom `track()` events (`count`, `visitors`; extra dims `eventName`, `eventData/<prop>`). **Hobby has no custom events**, so we'd skip these unless the club goes Pro.

### Errors to handle
The error body is always `{"error":{"code":"…","message":"…"}}`. The OpenAPI spec lists 200, 400, 401, 402, 403, 404, 410 and 503 for all four web-analytics endpoints; only 400, 401 and 403 have descriptions. 429 and 500 aren't listed per endpoint but are generic REST errors.

| Status | Meaning / action |
|---|---|
| 400 `bad_request` | "One of the provided values in the request query is invalid." Bad `by`/`filter`/dates. The message names the problem, e.g. an unsupported subject. A bug on our side, so log it and don't retry |
| 401 | "The request is not authorized." Per the getting-started guide: the API didn't accept the auth details, i.e. the token or `Authorization: Bearer` header is missing or malformed |
| 403 `forbidden` | "You do not have permission to access this resource." Wrong scope **or expired token** (the getting-started guide says to "check the token's expiration and scope" on 403). Live example: `Not authorized: Trying to access resource under scope "…". You must re-authenticate to this scope or use a token with access to this scope.` Handle 401 and 403 the same way: show "token needs replacing" |
| 402 | Listed with no description. **UNVERIFIED** guess: plan limit, e.g. a range beyond the reporting window. Clamp `since` to now−30d to avoid it |
| 404 `not_found` | Listed with no description. Live: "Web Analytics not found." when analytics is not enabled; a wrong project id probably looks the same |
| 410 / 503 | Listed with no description (**UNVERIFIED** meaning). Treat 503 (and a generic 500 `internal_server_error`) as transient: retry once with backoff |
| 429 `rate_limited` | Generic REST error. Body adds `limit: {remaining, reset, resetMs, total}` (`reset` in epoch seconds, `resetMs` in ms). Back off until `reset` |

## 4. Webhooks/events

None for analytics on our plan. Push delivery of Web Analytics data exists only as **Drains** (schema `analytics` v2, custom HTTP endpoint), and Drains are **Pro/Enterprise only** (Hobby and Pro Trial must upgrade). For reference only: drain requests carry `x-vercel-signature` = hex HMAC-SHA1 of the raw body keyed with the drain's signature secret (compare in constant time), and `user-agent: VercelDrain/1.0 (+https://vercel.com/docs/drains)`. Not usable on Hobby, so our "events" come from the pg_cron poll.

## 5. Rate limits, quotas, plan limits, retention

- **API rate limit:** the published limits table (checked 2026-10-22) has **no entry for the web-analytics query endpoints** (**UNVERIFIED** number). REST limits are per endpoint (errors doc) and each has a scope of owner, user, team or project (limits doc). Responses reportedly carry `X-RateLimit-Limit` / `-Remaining` / `-Reset`, with reset in epoch seconds. That comes only from a search summary of an older API reference page; no current Vercel page or the OpenAPI spec mentions these headers, so it stays **UNVERIFIED**. The 429 body's `limit.reset`/`resetMs` is documented, so key the backoff off the body. Our load is about 5 calls/day for the snapshot plus cached admin and Jack calls, far below any plausible limit. Related: "Speed Insights aggregate queries" are limited to 400/hour per team.
- **Hobby Web Analytics:** 50,000 events/month, **shared across every project on the account**. Page views and custom events both count, but Hobby can't send custom events. Extra events can't be bought. Past the cap there is a 3-day grace period, then collection pauses. The pricing page says it resumes "until the next billing cycle" in one place and "wait 7 days" in another, so the docs contradict each other. Vercel emails as you near the cap.
- **Reporting window (retention): Hobby 1 month**, Pro 12, Pro + Web Analytics Plus ($10/mo) and Enterprise 24. Only the window is guaranteed. Vercel "may store your data for longer" so upgrades keep history, but don't rely on that. Aggregate endpoints only query inside the window.
- **Hobby feature gaps:** no custom events, no UTM dimensions (Plus/Enterprise only), no Drains. Bounce rate is not exposed by the API (only `pageviews` and `visitors`).
- **Speed Insights (free tier, all plans):** 10,000 events per **rolling 30 days**, shared across the team. Past that, collection pauses for at least 14 days, and stays paused while 30-day usage is above half the allowance. The dashboard shows only the Real Experience Score, over 24h/7d ranges. Full Core Web Vitals and Drains need Speed Insights Plus, which is Pro ($10 per project per month plus usage) or Enterprise only; Hobby must upgrade. **No documented public REST query API:** the REST reference only lists `POST /speed-insights/toggle`. The CLI (`vercel metrics vercel.speed_insights.lcp_ms --aggregation p75 …`) works without Observability Plus, and so does `vercel metrics vercel.analytics.page_view.count`. The CLI is backed by `POST /v2/observability/query`, an *untagged* endpoint whose `scope` object is undocumented (the MCP calls `/v2/observability/schema` "legacy"; the CLI uses a newer `/metrics/v1` catalog). Treat it as unstable or internal. **Recommendation: skip Speed Insights for Jack 2.0.**

## 6. Gotchas, policy and privacy

- **Visitors are day-scoped.** Visitors are identified by a hash of the request, no third-party cookies, and the visitor session is discarded after 24h. So `visitors` summed across daily rows overcounts. For a range total, use the range query (`count`, or `aggregate` without a time dim). **UNVERIFIED:** how the backend dedupes visitors across a multi-day range. Store daily rows *and* label weekly/monthly "visitors" as approximate when we sum snapshots.
- **UTC buckets.** `timestamp` values are UTC (`…Z`). The REST endpoint has no timezone param (confirmed: the OpenAPI params are only `projectId, by, since, until, limit, filter, teamId, slug`). The untagged observability query has `bucketTimezone`, but that endpoint is out of scope. Austin is UTC−5/−6, so a "day" runs 7pm–7pm local. Label it in the UI, or use `by=hour` and re-bucket into America/Chicago days ourselves.
- **Production only by default**, so preview deploys don't pollute the numbers. Good.
- **Referrer is partial:** for page views it is only recorded on the initial page view, only if the Referrer-Policy allows it, and only if the referring link has no `rel="noreferrer"`. Soft navigations carry none. Instagram and Discord in-app browsers often strip it (**UNVERIFIED** for our traffic). Expect a large "(direct)" share.
- **`requestPath` vs `route`:** `requestPath` is the concrete URL (no query string). `route` is the framework pattern (`/drivers/[handle]`). Use `route` for "which section", `requestPath` for "which event page".
- **Admin pages count toward the 50k quota** and show up in the data, because `<Analytics />` sits in the root layout with no `beforeSend`. Consider a `beforeSend` that drops `/admin*` (and any path that embeds IDs) to save quota and keep admin URLs out of the dataset. That would be a separate small PR.
- **Data is aggregate and anonymous:** no IP or user linkage, query params filtered. Safe to show to officers and Jack. Public `/drivers/<handle>` paths are already public. Never show this card on public pages without review.
- **Token blast radius:** see §2. A project token can write to the prod project. Keep it server-only, wrap it in a two-endpoint allowlist client, never log it, and never let model output pick the URL path.
- **API is new** (GA 2026-05-18) and the hostname-filter feature request is still open, so expect additions. Pin our types to the fields we use and tolerate extra fields.
- Not researched: whether Vercel's Hobby non-commercial usage terms fit the club. That is outside this spec.

## 7. How to fake it locally

Build a tiny HTTP fake: a Next route under `/api/dev/fake-vercel/*`, or a standalone `tsx` server. Point `WEB_ANALYTICS_API_BASE` at it. The real client must use the **same code path** against the fake; only the base URL differs. The fake must reproduce:

1. **Routes:** `GET /v1/query/web-analytics/visits/aggregate` and `GET /v1/query/web-analytics/visits/count`. Anything else returns 404 `{"error":{"code":"not_found",…}}`.
2. **Auth:** no `Authorization: Bearer` header → 401. A token not equal to `FAKE_VERCEL_TOKEN` → 403 `forbidden` with the scope message. A known "expired" token → 403 (the getting-started guide ties expiry to 403; the exact code for expiry is unconfirmed, so make it switchable to 401 and make the client treat both the same). If `teamId` is present with a project token, ignore it.
3. **Project:** an unknown `projectId` returns 404 `{"error":{"code":"not_found","message":"Web Analytics not found."}}`. Accept either the id or the project name.
4. **Validation (400 `bad_request`):**
   - `by` missing, or more than 2 items, or duplicates, or two time granularities, or a value outside the enum.
   - `since`/`until` missing on aggregate.
   - `limit` outside 1–100.
   - `filter` longer than 2048 chars.
   - a filter subject not in the allowed list, using the community thread's wording (`Unsupported subject "requestHostname"`, followed by the allowed subjects).

   Parse `by` from **repeated keys**, and also accept a single key.
5. **Data model:** seed about 45 days of synthetic page-view events. Each event has `ts, requestPath, route, referrerHostname, country, deviceType, browserName, osName, environment, visitorHash`.
   - Use LSR paths (`/`, `/events`, `/events/[slug]`, `/drivers/[handle]`, `/lsc`, `/apply`, `/news/[slug]`, `/shop`).
   - Referrers: `instagram.com`, `discord.com`, `google.com`, `linktr.ee`, `t.co`, plus empty.
   - Country: mostly `US`.
   - deviceType: mobile, desktop or tablet, in one configurable case.
   - `environment`: mostly `production`.

   Make it deterministic: seeded RNG, plus an injectable "now".
6. **Semantics:**
   - Default filter `environment eq 'production'` unless the filter mentions `environment`.
   - Inclusive `since`/`until`, snapped to the granularity, in UTC.
   - `visitors` = distinct `visitorHash` per (bucket × group), with the hash rotated daily.
   - Rows sorted by `pageviews` desc.
   - Beyond `limit`, the remainder is collapsed into one `"Others"` row (keep this in one function so it's easy to change once we see the real shape).
   - Time buckets emit `timestamp` ISO strings.
   - The response envelope is `{version:1, query:{since,until,groupBy,filter?,limit}, data}`. Count returns `data:{pageviews,visitors}`.
7. **OData subset:** `eq`, `ne`, `in (...)`, `and`, `or`, `not`, parentheses, `startswith(field,'x')`. Single-quoted strings, with `''` as an escaped quote.
8. **Plan window:** with `FAKE_PLAN=hobby`, `since` older than now−1 month is clamped (returns empty buckets). A toggle switches this to a 402 instead, so the client's clamping and error path both get tested.
9. **Fault injection** via a header or env var: 429 with `X-RateLimit-*` headers and the `error.limit` object, 503 once, a slow response (to check that our timeout stays well under the 300 s function cap), and 410.
10. **Contract test:** one Vitest suite runs the client against the fake. An opt-in script (`pnpm tsx scripts/web-analytics-smoke.ts`) runs the same assertions against the real API, so the fake is checked when the token exists. Record the first real responses (with values scrubbed) as fixtures.

## 8. Sources

- https://vercel.com/docs/analytics/web-analytics-api: guide, examples, response shapes
- https://vercel.com/changelog/web-analytics-api: GA 2026-05-18
- https://vercel.com/docs/rest-api/web-analytics/aggregates-page-views
- https://vercel.com/docs/rest-api/web-analytics/counts-page-views
- https://vercel.com/openapi.json: `aggregatePageviews` params, enums, `by` pattern, response schema
- https://vercel.com/docs/rest-api: endpoint index (web-analytics, `/speed-insights/toggle`, `/v2/observability/query`)
- https://vercel.com/docs/rest-api/untagged/createobservabilityquery
- https://vercel.com/docs/rest-api/getting-started: token scopes, 401/403/429
- https://vercel.com/docs/rest-api/errors: error envelope, `rate_limited` body
- https://vercel.com/docs/limits: rate limit table and semantics
- https://vercel.com/docs/accounts/access-tokens and https://vercel.com/changelog/project-scoped-tokens
- https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token
- https://vercel.com/docs/analytics/limits-and-pricing: Hobby 50k events, 1-month window
- https://vercel.com/docs/analytics/privacy-policy: visitor hash, 24h, collected fields
- https://vercel.com/docs/analytics/using-web-analytics and https://vercel.com/docs/analytics/filtering
- https://vercel.com/docs/analytics/accessing-metrics-with-vercel-cli and https://vercel.com/docs/cli/metrics
- https://vercel.com/docs/speed-insights/limits-and-pricing and https://vercel.com/docs/speed-insights/accessing-metrics-with-vercel-cli
- https://vercel.com/docs/drains and https://vercel.com/docs/drains/security
- https://vercel.com/docs/agent-resources/vercel-mcp/tools/web-analytics
- https://community.vercel.com/t/web-analytics-api-support-filtering-by-hostname-already-supported-in-the-dashboard/46005
- Live read-only probes via the Vercel MCP on 2026-10-22: a 403 scope error on the LSR project (current login lacks access) and a 404 "Web Analytics not found." on unrelated projects without analytics. No successful real response has been captured yet.

## Checked

Second pass on 2026-10-22, against Vercel's docs and the live `https://vercel.com/openapi.json`. No new live API calls were made.

**Verified:**
- All 4 endpoints are `GET` with bearer auth (`security: bearerToken`): `/v1/query/web-analytics/{visits|events}/{count|aggregate}`. Their operationIds are `aggregatePageviews`, `countPageviews`, `aggregateEvents` and `countEvents`. The API went public on 2026-05-18.
- Aggregate params match §3a: `by` is required (1–2 unique items, at most one time granularity, enum plus a `flags/<key>` pattern). `since`/`until` are required, inclusive, and take ms or a Date string. `limit` is 1–100 with default 10, and the remainder goes to "Others". `filter` is OData, max 2048 chars, and defaults to production. There is no pagination and no timezone param. `requestHostname` isn't in the `by`/`filter` enums. Count makes the dates optional, is production only and counts "since Web Analytics was enabled".
- Response shapes match the guide's examples (`version: 1`, `query`, `data`; `timestamp` in UTC ISO).
- Tokens: the `vcp_` prefix, Full Account/Team/Project scopes, and project tokens (2026-07-30) that are read+write on one project only. Project tokens are denied on other projects and on team- and user-level resources, need no `teamId`/`slug`, can't mint tokens, and require team membership to create. There's no read-only option, and expired tokens stop working.
- Errors: the `{"error":{code,message}}` envelope and the `rate_limited` body with `limit{remaining,reset,resetMs,total}`. Rate limits are per endpoint. The limits table has no web-analytics query row and lists Speed Insights aggregate at 400/h per team.
- Plans: Hobby includes 50k events/month across the account and can't buy more. Over the cap there's a 3-day grace period, and the docs contradict themselves on resume ("next billing cycle" vs "wait 7 days"). Reporting windows are 1/12/24/24 months. Web Analytics Plus is $10/month per team. Hobby has no custom events and no UTM. "May store your data for longer" is also confirmed.
- Speed Insights free tier: 10k events per rolling 30 days, a pause of at least 14 days, RES only, 24h/7d ranges. The REST index only lists `POST /speed-insights/toggle`, plus the untagged `/v2/observability/query` whose `scope` object is undocumented. `vercel metrics` works for both products without Observability Plus.
- Drains: Pro/Enterprise only, `analytics` schema v2, and `x-vercel-signature` = hex HMAC-SHA1 of the raw body with the drain secret (docs advise a constant-time compare). User-agent is `VercelDrain/1.0 (+https://vercel.com/docs/drains)`.
- Privacy and data: a request hash with no third-party cookies, discarded after 24h. Query params are filtered. The referrer only comes from the initial page view and follows Referrer-Policy. `requestPath` vs `route` works as described.
- Repo: `@vercel/analytics` ^1.5.0, and a bare `<Analytics />` (no `beforeSend`) in `apps/platform/src/app/layout.tsx`.

**Corrected:**
- The count operationId is `countPageviews` (it wasn't given).
- An expired token is tied to **403** in Vercel's getting-started guide, not 401. The errors table and the fake were updated, and the client should treat both the same.
- 402/404/410/503 *are* listed in the OpenAPI spec, just without descriptions. 429 and 500 are generic.
- The community thread's error wording is `Unsupported subject "requestHostname"`, not `subject … is unsupported`, and its HTTP status isn't shown.
- Speed Insights Plus is Pro *or Enterprise*. The pause continues while 30-day usage is above half the allowance.
- Wording: "no third-party cookies"; the referrer also needs no `rel="noreferrer"`; `version` is typed as a number; the two-branch `data` schema.
- Resolved: the REST API has no timezone param. Added that the create-token API has no permission field, and that the guide's examples pass `teamId` only because they assume a full-account token.

**Still UNVERIFIED:**
- The rate-limit number for web-analytics queries, and whether `X-RateLimit-*` headers are sent (no current official page mentions them).
- The exact dashboard expiry choices. "No Expiration" appears only in third-party guides, and the API's `expiresAt` is optional.
- Whether a project token can read decrypted env values (assume yes).
- Whether count without dates is capped by the Hobby window.
- Comma-joined `by`.
- The meaning of 402/410.
- The real "Others" row shape, row ordering, the two-dimension layout, `deviceType` casing and `country` format.
- How visitors are deduped across multi-day ranges.
- The CLI's backing endpoint and the `/metrics/v1` and "legacy" schema claims (not in the docs I checked).
- The live-probe claims about the LSR team (taken from the first pass, not re-run).
