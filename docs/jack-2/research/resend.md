# Resend: delivery status for Jack 2.0

Researched 2026-10-22 from Resend's docs (raw `.md` pages and `openapi.json`), the Svix docs, and the installed SDKs (`resend@6.9.3`, `svix@1.84.1`). **UNVERIFIED** marks claims the docs don't state.

**Recommendation:**
- Use **webhooks** as the source of truth.
- Store every event in our own table, and have Jack read only that table.
- Don't poll `GET /emails/{id}`. It needs a full-access key, it returns only one `last_event` that later events overwrite, and the data is gone after 30 days.

## 1. What we'd use it for

The app already sends through Resend:
- `src/lib/email/resend.ts` does single sends and batches (permissive validation, idempotency keys, retries).
- The Resend id is saved in `Notification.emailMessageId` or `ApplicationEmail.resendMessageId`.

Jack 2.0 should answer "did the members get the event reminder?" and "which addresses bounce?". To do that it needs each email's outcome: `delivered`, `bounced`, `complained`, `opened` and `clicked`, plus `failed`, `suppressed` and `delivery_delayed`.

Resend pushes these as signed webhooks. A Vercel route can receive them: no daemon, and no money moves. We store them in Postgres so they outlive Resend's 30-day retention. Jack then reads them with `jack_readonly` like any other table.

## 2. Auth and setup

**API keys.** Header `Authorization: Bearer re_...`. A `User-Agent` header is also required: without one, the API returns 403 (error code 1010). The SDK sends it.
- There are only two permissions:
  - `full_access`: create, delete, get and update any resource.
  - `sending_access`: send only. It can optionally be restricted to one domain (`domain_id`).
- **There is no read-only key.** Any GET (`/emails/{id}`, `/emails`, `/emails/metrics`, `/webhooks/...`) needs `full_access`. A sending key gets `401 restricted_api_key` ("This API key is restricted to only send emails").
- A key is shown once. Name and permission can be edited in the dashboard; the API can only rename it.
- Keys don't expire and there's no refresh. Rotate a key by creating a new one and deleting the old.
- The rate limit is per team, so all keys share it.

**Webhooks need no API key at runtime.** Only the endpoint's signing secret (`whsec_...`) is needed, to verify requests.

**Setup steps (once, in the dashboard, by a team admin):**
1. Keep the prod `RESEND_API_KEY` as **Sending access**, restricted to our sending domain. Check its current permission in the dashboard.
2. Go to Webhooks → Add Webhook. Enter `https://<prod-host>/api/resend/webhook` and pick the events `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, plus `email.opened` and `email.clicked` if tracking gets turned on (section 6).
3. Copy the signing secret into Vercel as `RESEND_WEBHOOK_SECRET` (Production only).
4. Optional: turn on click tracking for the domain under Domains → Configuration (needs a tracking-subdomain CNAME).

**Env vars:**

| Var | Where | Notes |
|---|---|---|
| `RESEND_API_KEY` | exists | `sending_access`; unchanged |
| `RESEND_WEBHOOK_SECRET` | new, Vercel prod | `whsec_...`; for verifying only |
| `RESEND_BASE_URL` | local/test only | the SDK reads it at module load (`process.env.RESEND_BASE_URL \|\| "https://api.resend.com"`); point it at the fake |
| `RESEND_ADMIN_KEY` | **don't add** | a full-access key is only needed for polling, metrics or webhook-event APIs. If one is ever needed, keep it out of Vercel and use it only from a local script |

**Secret rotation:** `POST /webhooks/{webhook_id}/signing-secret/rotate` (returns `{ object: "webhook", id, signing_secret }`), or rotate in the dashboard. For 24 h after a rotation, payloads are signed with both the old and the new secret, so either one verifies.

## 3. Endpoints we need

Base URL `https://api.resend.com`. Errors look like this:
```json
{ "name": "validation_error", "statusCode": 422, "message": "..." }
```

### 3a. Send batch: `POST /emails/batch` (already used; documents what we get back)
- **Body:** a JSON array of up to **100** emails, each with up to 50 `to` addresses. `attachments` isn't supported. `tags` are supported: `[{name, value}]`, ASCII letters, digits, `_` and `-`, at most 256 characters each and 75 tags per email.
- **Headers:**
  - `Idempotency-Key`: up to 256 characters, kept 24 h.
  - `x-batch-validation: strict|permissive`: in the SDK this is `batchValidation`. The default is `strict`.
- **Strict mode:** if any email is invalid, the whole request fails. On success, `data[i]` is the id of request item `i` (0-based, same order).
```json
{ "data": [ { "id": "ae2014de-c168-4c61-8267-70d2662a1ce1" }, { "id": "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb" } ] }
```
- **Permissive mode:** valid emails are queued and invalid ones come back in `errors: [{ index, message }]` (`index` is 0-based into the request). The SDK types define this field ("only present when header x-batch-validation is set to 'permissive'"). Search snippets of the removed docs page say the valid emails "are queued and returned in `data`". **UNVERIFIED:** whether `data` then holds only the accepted emails, in request order (which is what `sendBatchEmails` assumes, and it logs a mismatch), or one placeholder per request item. Resend's validation-modes doc page and its changelog post both return 404, and `openapi.json` doesn't define the header or `errors`, so the only sources are the SDK types and search snippets. Test it once with one bad address in a batch.
- **Batch emails start as `queued`.** Every email in a batch gets its own id and its own webhook events.
- **Errors:**
  - 400 `validation_error` (bad field) or `invalid_idempotency_key` (key not 1-256 characters)
  - 422 `missing_required_field`, `missing_required_parameter` or `invalid_parameter`
  - 401 `missing_api_key`, `restricted_api_key`, or `validation_error` (invalid key on a sending endpoint)
  - 403 `validation_error` (unverified `from` domain, or test-mode send to someone else), `restricted_api_key` (key not active), `suspended_api_key`
  - 409 `concurrent_idempotent_requests` (retry) or `invalid_idempotent_request` (same key, different body)
  - 429 `rate_limit_exceeded`, `daily_quota_exceeded` or `monthly_quota_exceeded`
  - 500 `application_error`, 503 `service_unavailable`

### 3b. Retrieve email: `GET /emails/{id}` (fallback only, needs full_access)
```bash
curl https://api.resend.com/emails/4ef9a417-02e9-4d39-ad75-9611e0fcc33c -H 'Authorization: Bearer re_xxx'
```
```json
{ "object": "email", "id": "4ef9a417-...", "to": ["delivered@resend.dev"], "subject": "Hello World",
  "created_at": "2026-04-03 22:13:42.674981+00", "last_event": "delivered", "scheduled_at": null,
  "tags": [ { "name": "category", "value": "confirm_email" } ] }
```
- **`last_event` values:** `bounced`, `canceled`, `clicked`, `complained`, `delivered`, `delivery_delayed`, `failed`, `opened`, `queued`, `scheduled`, `sent`, `suppressed`.
- **It's a single value**: an email that was delivered, then opened, then clicked shows only `clicked`. There's no per-email event history in the API.
- **Errors:** 404 `not_found`, 401 `restricted_api_key`, 429.
- **UNVERIFIED:** that an email older than the 30-day retention returns 404.

### 3c. List emails: `GET /emails?limit=&after=|before=` (fallback only, needs full_access)
- **Paging:** cursors. `limit` is 1-100 (default 20). Use `after` *or* `before`, never both.
  - The response is `{ object: "list", has_more, data: [...] }`, newest first.
  - Next page: `after=<last id>`. Newer items: `before=<first id>`.
- **Each item has** `id`, `message_id`, `to`, `from`, `subject`, `created_at`, `last_event`, `scheduled_at` (and cc, bcc, reply_to).
- **No filters** by status, tag or date.
- **Paging the whole month costs** 3,000 emails ÷ 100 = 30 requests.

### 3d. Email metrics: `GET /emails/metrics` (optional, needs full_access)
- **What it returns:** counts and rates (`delivered`, `bounced_permanent`, `unique_opened`, `complained`, `bounce_rate`, `complaint_rate`, ...).
- **Filters and grouping:** `start_date` (default 6 days before `end_date`), `end_date` (default now), `timezone`, `granularity` (`hourly|daily|weekly|monthly`, with `period`), `metrics[]`, `domain_id[]`, `email_id[]` or `broadcast_id[]` (up to 100 each), and `dimensions` from `period`, `domain`, `email`, `broadcast` (`email` and `broadcast` can't be combined).
- **Limits:**
  - Responses are cached for up to 15 min.
  - Dates are clamped to the 30-day retention.
  - Opens and clicks need tracking turned on.
- **Field names per item when grouped by `email`: UNVERIFIED.** The docs only show the `period` and `domain` example:
```json
{ "object": "metrics", "totals": { "sent": 1204, "delivered": 1180 }, "data": [ { "period": "2026-07-01", "domain_id": "d91c...", "sent": 172, "delivered": 169 } ] }
```
- **Use:** a weekly bounce/complaint health check that we could compute from our own events table anyway. Skip it for v1.

### 3e. Webhook event APIs (headless, launched 2026-09-16; need full_access)
- **`GET /webhooks/{webhook_id}/events?limit=&after=`:** paged most recent first, `before` not supported. Each item is `{ id: "msg_...", type, created_at, status: success|failed|attempting|pending }`.
- **`GET /webhooks/{webhook_id}/events/{event_id}`:** returns `{ object: "webhook_event", id, type, status, next_attempt_at, payload }`.
- **`GET .../events/{event_id}/attempts`:** each attempt is `{ id, http_status_code, response, sent_at }`.
- **`POST .../events/{event_id}/replay`:** queues one more delivery. Retries already scheduled continue as before.
- **`POST /webhooks/{webhook_id}/signing-secret/rotate`:** shipped in the same release (see section 2).
- **Retention:** "Only events inside your plan's data retention window are returned", so 30 days on our plan.
- **Use:** recovering after an outage, run by hand from a local script with an admin key. The dashboard has the same Replay button.

## 4. Webhooks (the primary mechanism)

**Delivery:**
- An HTTPS `POST` with a JSON body, **one event per recipient**: `to` is still an array but holds a single address (changelog "Webhook event visibility", 2026-01-22).
- **Return 200** to acknowledge: Resend's create-webhook page says it retries when it doesn't get a 200. Svix itself accepts any 2xx, answers must come within **30 s**, and 3xx counts as a failure. **UNVERIFIED** whether Resend changes the 30 s or 3xx defaults; returning a plain 200 fast satisfies either way.
- Delivery is **at-least-once**, so expect duplicates. **Order isn't guaranteed**: `opened` can arrive before `delivered`. (Both come from the Svix docs; Resend's own pages only say to dedupe on `svix-id`.)
- **Retries** happen after: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. That's about 27.6 h in all. (Resend's "how to store webhooks data" page rounds this to "up to 24 hours".)
  - An endpoint that keeps failing is **disabled automatically**, and the team gets an email. Re-enable it in the dashboard.
  - The Svix default is to disable after 5 days of failures. **UNVERIFIED** for Resend.
- **Source IPs:** 44.228.126.217, 50.112.21.217, 52.24.126.164, 54.148.139.208 and 2600:1f24:64:8000::/52. We don't need an allowlist because we check signatures.

**Payload** (shared shape; `type` is `email.<event>`):
```json
{ "type": "email.bounced", "created_at": "2026-11-22T23:41:12.126Z",
  "data": { "email_id": "56761188-7520-42d8-8898-ff6fc54ce618", "created_at": "2026-11-22T23:41:11.894Z",
    "message_id": "<111-222-333@email.example.com>", "from": "LSR <noreply@...>", "to": ["member@utexas.edu"],
    "subject": "Event reminder", "tags": { "kind": "notification", "nid": "ck123" },
    "bounce": { "type": "Permanent", "subType": "General", "message": "...", "diagnosticCode": ["smtp; 550 5.1.1 ..."] } } }
```

**Extra object for each event type:**

| Event | Extra object |
|---|---|
| `email.bounced` | `bounce{type: Permanent\|Transient\|Undetermined, subType, message, diagnosticCode[]}`. Subtypes: Permanent → `General`, `NoEmail`; Transient → `General`, `MailboxFull`, `MessageTooLarge`, `ContentRejected`, `AttachmentRejected`; Undetermined → `Undetermined` |
| `email.clicked` | `click{link, timestamp, ipAddress, userAgent}` |
| `email.failed` | `failed{reason}`, e.g. `reached_daily_quota`; the full list of reasons is UNVERIFIED |
| `email.suppressed` | `suppressed{type, message}`, e.g. `OnAccountSuppressionList` |
| `email.opened` | none (no IP or user agent) |
| `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.complained` | none |

Notes on the payload:
- `tags` arrive as an **object** (`Record<string,string>`), but are sent as an array of `{name, value}`.
- `email.delivery_delayed` isn't final: Resend keeps retrying for up to 14 h, then marks the email `bounced`.
- `broadcast_id` and `template_id` only appear when they apply.
- SDK 6.9.3's types leave out `message_id` and `bounce.diagnosticCode`, but the docs include both. Type the payload ourselves.

**Signature check (Svix):**
- **Headers:**
  - `svix-id`: the message id `msg_...`, the same on retries.
  - `svix-timestamp`: Unix seconds.
  - `svix-signature`: a space-separated list like `v1,<base64> v1,<base64>`. During a rotation it holds more than one entry.
- **Steps:**
  1. Read the **raw** body: `const body = await req.text()` in a Next.js route handler. Parsing and re-serializing the JSON breaks the signature.
  2. `signedContent = `${svixId}.${svixTimestamp}.${body}``
  3. `key = base64decode(secret.slice("whsec_".length))`, then `expected = base64(HMAC_SHA256(key, signedContent))`.
  4. Strip the `v1,` prefix from each entry in `svix-signature`. Accept the request if any entry matches `expected` under a constant-time compare.
  5. Reject if `|now - svixTimestamp| > 300 s`. That's the tolerance in the library (`standardwebhooks`); Svix tells receivers to enforce one.
- **In code:**
```ts
// Either: the SDK wraps svix (throws on a bad signature, returns the parsed payload)
const evt = resend.webhooks.verify({ payload: body, webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  headers: { id: h.get("svix-id")!, timestamp: h.get("svix-timestamp")!, signature: h.get("svix-signature")! } });
// Or: new Webhook(secret).verify(body, { "svix-id", "svix-timestamp", "svix-signature" }) from "svix"
```
- **Svix's test vector:**
  - secret `whsec_plJ3nmyCDGBKInavdOK15jsl`
  - id `msg_loFOjxBNrRLzqYUf`
  - ts `1731705121`
  - body `{"event_type":"ping","data":{"success":true}}`
  - expected signature `v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=`
  - The timestamp is old, so test the HMAC on its own or freeze the clock.

**Handler plan for `src/app/api/resend/webhook/route.ts`** (follow `api/stripe/webhook`):
1. Verify the signature. On failure, return 400 and log no addresses.
2. Insert into a new `EmailEvent` table with `svixId @unique`, `emailId`, `type`, `occurredAt` (= `data.created_at` for the email, `created_at` for the event), `recipient` and a small `detail` JSON (bounce or failed reason; click link only).
3. If `svixId` already exists, return 200.
4. Match `emailId` to `Notification.emailMessageId` or `ApplicationEmail.resendMessageId`. Events for emails we don't know (dashboard sends, other apps) still get stored.
5. Return 200 fast and do nothing slow in the handler.
6. Work out the "current status" when reading, not by arrival order:
   - **Final states:** complained > bounced > failed > suppressed.
   - **Engagement:** clicked > opened, and either one implies delivered.
   - **Otherwise:** delivered > delivery_delayed > sent.
7. The table holds recipient addresses, so copy the RLS and `jack_readonly` policy tail from `add_recruiting` (see `codebase-infra.md`).

## 5. Rate limits, quotas, plan limits, retention

- **API rate limit:**
  - **10 requests per second per team**, shared by every key, in a per-second window with no burst allowance. Going over gives 429 `rate_limit_exceeded`.
  - Responses carry the headers `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and `retry-after`.
  - It's the same on every plan; to raise it, ask support.
  - A batch call counts as 1 request. Polling would share this budget with our sends.
- **Free plan quota:**
  - **100 emails a day**, a UTC calendar day that resets at 00:00 UTC, and **3,000 a month**.
  - Every to, cc and bcc address counts. Received emails and test sends to `@resend.dev` count too.
  - Usage comes back in the response headers `x-resend-daily-quota` (Free only) and `x-resend-monthly-quota`.
  - Going over gives 429 `daily_quota_exceeded` or `monthly_quota_exceeded`, or the async webhook `email.failed` with `reason: reached_daily_quota`.
- **Free plan features:**
  - **1 webhook endpoint** (Pro has 5, Scale 10), receiving all event types.
  - 3 domains. Open and click tracking are available on Free.
- **Retention:** **30 days on Free, Pro and Scale** for email content, metadata, delivery status, events, logs and metrics. Only Enterprise can set a different retention.
  - A webhook payload is the only copy we keep beyond that.
  - Our privacy page says "Email delivery logs: up to 1 year", so prune `EmailEvent` at 12 months, for example with a pg_cron delete.
  - Webhook events stay listable through the headless API only inside the same 30-day window (per the headless webhook API changelog).
- **Account health:**
  - Keep the bounce rate under **4%** and the spam-complaint rate under **0.08%**, or sending may be paused.
  - Hard bounces and complaints add the address to the account suppression list automatically. Later sends to it produce `email.suppressed`.

## 6. Gotchas, policy and privacy

- **The two sources use different time formats.** `GET /emails` uses Postgres-style `"2026-04-03 22:13:42.674981+00"`; webhooks use ISO 8601. Parse both.
- **Opens are unreliable.** They miss plain-text emails and clients that block images, and they give false positives from Apple Mail Privacy Protection and security scanners.
  - Resend **recommends turning off open tracking for transactional email** because it hurts inbox placement.
  - Recommendation: no open tracking. Click tracking only if officers really want it, and treat a click as "engaged", not proof of reading.
- **Tracking is set per domain and is off by default.**
  - It needs a verified tracking subdomain (CNAME, plus CAA if we have CAA records).
  - It rewrites every link in every email from that domain.
  - A tracking subdomain can be changed but never removed. Removing the domain breaks old tracked links.
- **Click events include the recipient's IP and user agent.** That's personal data we don't need: drop `ipAddress` and `userAgent` before storing.
- **Turning tracking on changes what we collect.** Update the Resend row on `/privacy` ("delivery status" would become "delivery and engagement status") before enabling it.
- **Previews and local dev can't receive real webhooks.**
  - The Free plan's single endpoint belongs to prod.
  - The Resend CLI's `webhooks listen --url <public url>` registers a temporary webhook (removed on exit) and needs our own tunnel for the public URL; whether it hits the 1-endpoint limit is **UNVERIFIED**.
  - Use the fake (section 7).
- **Don't let middleware rewrite the route.** Make sure no auth middleware or proxy redirects `/api/resend/webhook` (3xx counts as a failure).
- **The `svix-id` and headless event ids look alike.** List Events returns ids like `msg_...`, and **UNVERIFIED** that they are the same as `svix-id`. Dedupe on `svix-id` either way (Svix docs confirm it stays the same across retries of one message).
- **`last_event` only works for one recipient.** With several `to` addresses it is one value for all of them. We send one recipient per email, so it's fine as a fallback; webhooks are per recipient anyway.
- **"Delivered" isn't "in the inbox".** It means the receiving server accepted the email, which could still put it in spam.
- **There's no permanent opt-out of content storage on our plan.** Turning content storage off needs Pro or Scale for 1+ month, a $50/mo add-on, a sending domain with an active website, and 3,000+ emails sent with a bounce rate under 5%, so Resend keeps message bodies for 30 days.
- **Policy:** Resend requires consent to send. Mail that is really a newsletter needs an unsubscribe link plus `List-Unsubscribe` headers. Nothing here moves money.

## 7. How to fake it locally

**Wiring:** set `RESEND_BASE_URL=http://127.0.0.1:<port>`. The SDK reads it at import, so no app code changes, and the existing `vi.mock` unit tests stay as they are. Run the fake as a small Node HTTP server (or MSW handlers) under `apps/platform/scripts/fakes/`.

**Fake API must reproduce:**
- **Request checks:**
  - Require `Authorization: Bearer re_*`; without it, 401 `missing_api_key`.
  - Require a `User-Agent`; without it, 403.
  - Keys named `re_send_*` act as sending-only: any GET returns 401 `restricted_api_key`.
- **`POST /emails`:** returns `{id}` as a uuid v4.
- **`POST /emails/batch`:**
  - Strict mode: any invalid item gives 422 for the whole request; otherwise `data` follows request order.
  - Permissive mode: `{data, errors:[{index,message}]}`. Choose the `data` layout to match whatever the real check in section 3a finds.
  - More than 100 items: 422.
- **Idempotency:** remember keys for 24 h. The same key and body returns the same response. The same key with a different body gives 409 `invalid_idempotent_request`. A request still in progress gives 409 `concurrent_idempotent_requests`.
- **Limits:** 429 when there are more than 10 requests per second (with the `ratelimit-*` and `retry-after` headers). A daily counter gives 429 `daily_quota_exceeded` after 100 recipients per UTC day, or it can emit `email.failed`.
- **Read endpoints:**
  - `GET /emails/{id}` returns `last_event` and the Postgres-style `created_at`.
  - `GET /emails` pages newest first with `after`/`before`/`has_more`.
- **Errors:** every error body is `{name, statusCode, message}`.

**Fake webhook sender must reproduce:**
- **Outcome by recipient address,** using Resend's test inboxes (`+label` allowed):
  - `delivered@resend.dev` → `sent`, then `delivered`
  - `bounced@` → `sent`, then `bounced` (`Permanent`, smtp 550 5.1.1)
  - `complained@` → `sent`, `delivered`, then `complained`
  - `suppressed@` → `suppressed`
  - Optional: `delayed@` → `delivery_delayed`, then `bounced`. This one is ours, not Resend's.
  - Optional: `clicked@` → adds `opened` and `clicked` with `click.ipAddress` and `click.userAgent` filled in, to test that we drop them.
- **Per-recipient events:** one event per recipient, with `to: [single]`, `tags` as an object, and `data.created_at` in ISO.
- **Signing:**
  - Use `new Webhook(secret).sign(msgId, new Date(), body)` from `svix`, which produces `v1,<b64>`.
  - Send the headers `svix-id`, `svix-timestamp` and `svix-signature`.
  - Test modes: a bad signature, a stale timestamp (more than 300 s), and two signatures (rotation).
- **Delivery chaos:** knobs to deliver **duplicates** (same `svix-id`), **out of order** (`opened` before `delivered`), and **retries** (resend on non-2xx, keeping the `svix-id`).
- **Headless webhook API:** optional; skip it for v1.

## 8. Sources

- https://resend.com/docs/llms.txt
- https://resend.com/openapi.json
- https://resend.com/docs/api-reference/introduction.md
- https://resend.com/docs/api-reference/errors.md
- https://resend.com/docs/api-reference/rate-limit.md
- https://resend.com/docs/api-reference/pagination.md
- https://resend.com/docs/api-reference/emails/retrieve-email.md
- https://resend.com/docs/api-reference/emails/list-emails.md
- https://resend.com/docs/api-reference/emails/send-batch-emails.md
- https://resend.com/docs/api-reference/emails/get-metrics.md
- https://resend.com/docs/api-reference/api-keys/create-api-key.md
- https://resend.com/docs/api-reference/webhooks/create-webhook.md
- https://resend.com/docs/api-reference/webhooks/get-webhook.md
- https://resend.com/docs/api-reference/webhooks/list-webhooks.md
- https://resend.com/docs/api-reference/webhooks/list-events.md
- https://resend.com/docs/api-reference/webhooks/get-event.md
- https://resend.com/docs/api-reference/webhooks/list-event-attempts.md
- https://resend.com/docs/api-reference/webhooks/replay-event.md
- https://resend.com/docs/api-reference/webhooks/rotate-signing-secret.md
- https://resend.com/docs/api-reference/logs/list-logs.md
- https://resend.com/docs/webhooks/introduction.md
- https://resend.com/docs/webhooks/create-webhook.md
- https://resend.com/docs/webhooks/verify-webhooks-requests.md
- https://resend.com/docs/webhooks/retries-and-replays.md
- https://resend.com/docs/webhooks/event-types.md
- https://resend.com/docs/webhooks/how-to-store-webhooks-data.md
- https://resend.com/docs/webhooks/emails/bounced.md (likewise `clicked`, `complained`, `delivered`, `delivery-delayed`, `failed`, `opened`, `sent`, `suppressed`)
- https://resend.com/docs/dashboard/emails/manage-emails.md
- https://resend.com/docs/dashboard/emails/batch-sending.md
- https://resend.com/docs/dashboard/emails/idempotency-keys.md
- https://resend.com/docs/dashboard/emails/send-test-emails.md
- https://resend.com/docs/dashboard/emails/email-bounces.md
- https://resend.com/docs/dashboard/emails/tags.md
- https://resend.com/docs/dashboard/domains/tracking.md
- https://resend.com/docs/dashboard/api-keys/introduction.md
- https://resend.com/docs/create-an-api-key.md
- https://resend.com/docs/knowledge-base/account-quotas-and-limits.md
- https://resend.com/docs/knowledge-base/what-is-resend-pricing.md
- https://resend.com/docs/knowledge-base/how-do-i-ensure-sensitive-data-isnt-stored-on-resend.md
- https://resend.com/pricing.md
- https://resend.com/changelog/headless-webhook-api.md
- https://resend.com/changelog/email-metrics-api.md
- https://resend.com/changelog/webhook-event-visibility.md
- https://resend.com/changelog/new-api-key-permissions.md
- https://docs.svix.com/receiving/verifying-payloads/how-manual.md
- https://docs.svix.com/receiving/introduction.md
- https://docs.svix.com/retries.md
- Search result only (the page now returns 404): https://resend.com/docs/dashboard/emails/batch-validation-modes
- Local: `node_modules/resend/dist/index.{d.mts,mjs}` (6.9.3), `node_modules/.pnpm/svix@1.84.1`, `standardwebhooks@1.0.0`

## Checked

Second pass on 2026-10-22 against Resend's docs and changelog, the Svix docs and the installed SDKs.

**Verified:**
- Auth: `Authorization: Bearer re_...`, `User-Agent` required (403 / code 1010). Only two permissions, `full_access` and `sending_access` (optional `domain_id`); no read-only key; key value shown once; permission editable only in the dashboard.
- Rate limit: 10 req/s per team, shared by all keys, no burst; a batch counts as 1 request; `ratelimit-*` and `retry-after` headers; same on every plan.
- Free plan: 100/day (UTC day) and 3,000/month; to/cc/bcc, received and `@resend.dev` test sends all count; `x-resend-daily-quota` is Free-only. 1 webhook endpoint (Pro 5, Scale 10), 3 domains, tracking available. 30-day retention on Free/Pro/Scale. Bounce under 4%, complaints under 0.08%. Hard bounces and complaints auto-suppress.
- Batch: 100 emails, 50 `to` each, no attachments, tags (ASCII, 256 chars, 75 per email), `Idempotency-Key` up to 256 chars for 24 h, `data[i]` maps to request item `i`; SDK sends `x-batch-validation` (default `strict`).
- `GET /emails/{id}`, `GET /emails` (limit 1-100, default 20, `after` xor `before`), `GET /emails/metrics` (15-min cache, retention clamp), and the 12 `last_event` values.
- Headless webhook API (2026-09-16): list/get events, list attempts, replay, rotate; field shapes and statuses as written.
- Webhooks: per-recipient events, retry schedule, auto-disable plus email, source IPs, `delivery_delayed` retried up to 14 h then `bounced`, payload extras (bounce, click, failed, suppressed; opened has no IP/UA), tracking off by default and per domain, open tracking discouraged for transactional mail.
- Signature: headers, signed content `id.timestamp.body`, `whsec_` strip + base64 key, HMAC-SHA256, `v1,` entries, constant-time compare. The Svix test vector reproduces `v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=` with Node `crypto`. `standardwebhooks@1.0.0` rejects timestamps more than 300 s old or ahead; `resend.webhooks.verify` wraps `svix`'s `Webhook`. 24 h dual signing after rotation. SDK reads `RESEND_BASE_URL` at load and passes the raw `{name, statusCode, message}` error body through.

**Corrected:**
- Rotate path was `/webhooks/{id}/rotate-secret`; it is `POST /webhooks/{webhook_id}/signing-secret/rotate`.
- Batch error list: 422 is `missing_required_field` / `missing_required_parameter` / `invalid_parameter`, not `validation_error`; added `invalid_idempotency_key`, 401 `validation_error` and the 403 variants.
- Webhook ack: Resend's docs ask for a 200 (Svix accepts any 2xx); total retry span is about 27.6 h (Resend elsewhere says "up to 24 hours"); at-least-once and no ordering are sourced from Svix, not Resend.
- Added bounce subtypes, `message_id` on list items, the full metrics parameter set (incl. `broadcast` dimension), the extra conditions for turning content storage off, and that SDK types also omit `bounce.diagnosticCode`.
- Resolved: headless webhook events are only returned inside the plan's retention window (30 days).

**Still unverified:**
- Permissive batch `data` layout (accepted-only vs placeholder per item). Both the docs page and changelog post 404, and `openapi.json` is stale (no `x-batch-validation`, metrics, headless webhook or rotate paths). Test with one bad address.
- Resend's webhook timeout and auto-disable window (Svix defaults: 30 s, 5 days).
- 404 for emails past retention; the full `failed.reason` list; per-item metric fields with `dimensions=email`.
- Whether the CLI's temporary webhook counts toward the 1-endpoint limit; whether headless event ids equal `svix-id`.
- Required key permission for the headless webhook API is not stated anywhere; `full_access` is inferred from `sending_access` being send-only.
