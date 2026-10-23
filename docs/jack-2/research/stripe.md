# Stripe: read-only access for Jack (research, 10/22)

Vendor research for Jack 2.0. Sources are Stripe's own docs (read 10/22), plus the installed SDK (`apps/platform/node_modules/stripe`, v20.4.1). Anything not confirmed in a primary source is marked **UNVERIFIED**. Paths are under `apps/platform/` unless noted.

## 1. What we'd use it for
Jack answers officers' money questions from Stripe directly, never moving money:
- what's in the balance (available vs pending);
- when the next payout lands and which payments made it up;
- what came in for an event or the Lone Star Cup, and which payments were refunds or disputes;
- whether a payout failed.

All access goes through a **restricted API key (RAK) with Read on a few resources and nothing else**:
- Jack's on-demand tools call it live.
- A daily sync caches snapshots in Postgres, triggered by pg_cron + pg_net calling a Vercel function (no daemon).
- The existing webhook endpoint can optionally also receive payout and dispute events.

Payments today are Checkout Sessions created by `src/server/services/payment.service.ts`:
- `Payment.providerRef` starts as the `cs_…` id. When the payment succeeds, `claimPayment` overwrites it with `session.payment_intent` (the `pi_…` id), and `handleChargeRefunded` already finds payments by `charge.payment_intent`. Pending, expired and failed rows keep the `cs_…` id.
- `metadata.paymentId` sits on the **Checkout Session**, not on the PaymentIntent or Charge.
- Donations use Payment Link `plink_1UOs…`, whose payments carry `metadata.purpose = donation` (from the memory notes; verify on a live charge). Stripe copies a Payment Link's own `metadata` only to its Checkout Sessions. It reaches the PaymentIntent only if it was set as `payment_intent_data.metadata`, and the Charge gets a one-time copy of the PaymentIntent's metadata.

## 2. Auth and setup
**Key type.** A RAK (`rk_live_…` / `rk_test_…`) is a drop-in replacement for a secret key: same SDK, same `Authorization: Bearer` header. Each resource gets **None / Read / Write**, and **Write implies Read**. Every Stripe API supports RAKs. Stripe recommends RAKs over secret keys "especially when giving a key to an AI agent".

**Create it** (Dashboard → API keys → **Create restricted key**):
1. Start from zero permissions and name it `jack-read`.
2. Set the permissions below.
3. Complete 2FA and copy the key. **A live RAK you create yourself can't be revealed again.** Sandbox keys can always be revealed.
4. Add a note saying where the key is stored.

Optional extras:
- Creation offers to tag the key as an agent key ("Authorizing agent access to your account"). That subjects it to approval rules for sensitive actions such as payouts and refunds. That's harmless for a read-only key and a second guard if someone later adds Write. It changes nothing for reads: agent-tagged keys "work the same as other restricted API keys for authentication and permissions", and every action an approval rule can cover is a write (for example, creating a refund, a payout or a PaymentIntent).
- Do the setup in a sandbox first, then create a matching live key.

**Permissions to enable (Read).** Permission ids are from the API permissions reference. Dashboard labels come from the Stripe Apps permission list; the exact Dashboard wording is **UNVERIFIED**. (The RAK guide's own examples say "Disputes: Read" and "Payment Intents: Write", so the Dashboard may say "Disputes" rather than "Payment Disputes".)

| Permission id | Dashboard resource | Covers (GET only) |
|---|---|---|
| `balance_read` | Balance | `/v1/balance`, `/v1/balance_transactions`, `/v1/balance_transactions/{id}` |
| `payout_read` | Payouts | `/v1/payouts`, `/v1/payouts/{id}` |
| `charge_read` | Charges and Refunds | `/v1/charges`, `/v1/charges/{id}`, `/v1/charges/search`, `/v1/charges/{id}/refunds`, `/v1/refunds`, `/v1/refunds/{id}` |
| `payment_intent_read` | Payment Intents | `/v1/payment_intents`, `/v1/payment_intents/search`. `GET /v1/payment_intents/{id}` is still missing from the permissions table (rechecked 10/22); the Apps reference says Read covers "list and retrieve" (**UNVERIFIED** row; one retrieve call with the sandbox key settles it) |
| `dispute_read` | Payment Disputes | `/v1/disputes`, `/v1/disputes/{id}` |
| `checkout_session_read` (optional) | Checkout Sessions | `/v1/checkout/sessions?payment_intent=…` or `?payment_link=plink_…`. Not needed to join charges to `Payment` rows, because the webhook already stores `payment_intent` (§6). Its one use is listing donation sessions by `payment_link` |
| `event_read` (optional) | Events | `/v1/events`, a 30-day fallback if we poll instead of using webhooks |

**Leave off:**
- Every `*_write`. In particular, `charge_write` creates and cancels refunds, `payout_write` creates, cancels and reverses payouts, `dispute_write` submits evidence and closes disputes, and `payment_intent_write` captures and cancels.
- `balance_transaction_source_read`. It's only needed to `expand` `source` on balance transactions, and it also implies Read on Application Fees, Balance, Payouts, Transfers, Financing Transactions and Balance Transfers.
- `customer_read` and `payment_method_read`. `billing_details` on the charge already has name and email.
- `file_read` (dispute evidence uploads may hold PII).
- `webhook_read`/`webhook_write` (Stripe calls `webhook_read` "a sensitive permission").
- `connected_account_read`, `report_runs_and_report_types_read`, and all Billing, Issuing, Terminal and Tax permissions.

**Lifetime.** RAKs don't expire on their own:
- They last until you **Expire** or **Rotate** them.
- Rotating can keep the old key alive for up to 7 days.
- Keys unused for payouts/transfers for 180 days get "limited access" for those actions only, which doesn't matter for reads.
- No refresh flow.

**Access policies** (they replaced IP restrictions):
- An "Advanced" policy can allow by ASN and country and block VPNs, proxies and Tor.
- By default Vercel functions send requests from dynamic addresses, and Vercel publishes no IP range to allowlist. An ASN rule would need the AWS ASN (16509, Stripe's own example). That Vercel Node functions egress from it is **UNVERIFIED**; Vercel's docs don't name the provider.
- Vercel's Static IPs add-on (Pro and Enterprise, $100/month per project plus data transfer) gives functions a fixed egress IP pair per region. That IP pair would allow an "IP addresses" policy instead, but the IPs are shared with a few other Vercel customers.

**Env vars:**
- `STRIPE_JACK_READ_KEY`:
  - `rk_live_…` only in Vercel Production;
  - `rk_test_…` locally and in Preview.
  - At boot, refuse anything not starting with `rk_`, and refuse `rk_live_` when `VERCEL_ENV !== "production"`.
- `STRIPE_FAKE_URL`: for example `http://127.0.0.1:12111`. When set, point the SDK at the fake (§7).
- `STRIPE_WEBHOOK_SECRET` (existing): reused if payout/dispute events are added to the existing endpoint.
- Keep `STRIPE_SECRET_KEY` (checkout) entirely separate. Jack's code must never import `getStripe()` from `src/lib/stripe.ts`.

**API version:**
- Since 2024-09-30.acacia, Stripe ships monthly versions with no breaking changes, plus two majors a year that can break. The docs' current version is `2026-09-30.endive`.
- `stripe-node` v12+ pins requests to the API version current at its release, so TypeScript types match. The installed **20.4.1 pins `2026-02-25.clover`** (`cjs/apiVersion.js`), and `src/lib/stripe.ts` sets no `apiVersion`.
- Overriding `apiVersion` "might cause inaccurate Typescript types", so don't. Upgrade the SDK instead.
- Webhook payloads use the version set on the endpoint, or the account default.

**SDK setup (Node):**
```ts
import Stripe from "stripe";
const fake = process.env.STRIPE_FAKE_URL ? new URL(process.env.STRIPE_FAKE_URL) : null;
export const stripeRead = new Stripe(process.env.STRIPE_JACK_READ_KEY!, {
  maxNetworkRetries: 2,      // 20.4.1 code default is 2 (README still says 1)
  timeout: 20_000,           // default 80 s is too long inside a 300 s function
  telemetry: false,
  ...(fake && { host: fake.hostname, port: Number(fake.port), protocol: "http" as const }),
});
```
Auto-pagination:
- `for await (const x of stripeRead.charges.list({ created: { gte }, limit: 100 }))`. `break` stops it.
- Or `.autoPagingEach(fn)`, where returning `false` stops it.
- Or `.autoPagingToArray({ limit })`. `limit` is required, and the SDK throws if it's above 10,000.
- Pass `limit: 100` per page to cut request count.
- If the first call uses `ending_before`, the SDK pages backwards and results come oldest-first.

## 3. Endpoints we need
**Common to every list:**
- **Pagination:**
  - `limit` is 1–100 (default 10).
  - `starting_after` / `ending_before` take an object id, and the two are mutually exclusive.
  - Lists are newest first.
  - The envelope is `{ object: "list", url, has_more, data: [...] }`.
- **Date filters:**
  - Range filters (`created`, payouts' `arrival_date`) take an integer or `{gt,gte,lt,lte}` in Unix seconds.
  - The SDK encodes them as `created[gte]=…` and arrays as `expand[0]=…`. curl docs use `expand[]=`.
- **Money:** amounts are integers in the smallest unit (cents), and `currency` is lowercase.

**3.1 Balance:** `GET /v1/balance` (`balance_read`). No params.
```json
{ "object": "balance", "livemode": true,
  "available": [{ "amount": 666670, "currency": "usd", "source_types": { "card": 666670 } }],
  "pending":   [{ "amount": 61414,  "currency": "usd", "source_types": { "card": 61414 } }],
  "instant_available": null, "connect_reserved": [{ "amount": 0, "currency": "usd" }] }
```
- `available` can be paid out; `pending` hasn't settled yet.
- It's one array entry per currency. Ignore `instant_available`, `issuing`, `connect_reserved` and `refund_and_dispute_prefunding`.

**3.2 Payouts:** `GET /v1/payouts`, `GET /v1/payouts/{id}` (`payout_read`).
- **Params:** `status` (`pending|paid|failed|canceled`; **there's no `in_transit` filter** even though that status exists), `arrival_date`, `created`, `destination`.
- `stripeRead.payouts.list({ arrival_date: { gte: weekAgo }, limit: 100 })`
- The example below is the docs' sample with `automatic`, `status` and `reconciliation_status` changed to show an automatic payout. The docs' own sample is a manual `pending` payout with `not_applicable`.
```json
{ "id": "po_1OaF…", "object": "payout", "amount": 1100, "currency": "usd",
  "arrival_date": 1680652800, "created": 1680648691, "automatic": true, "method": "standard",
  "status": "in_transit", "type": "bank_account", "balance_transaction": "txn_1OaF…",
  "failure_code": null, "failure_message": null, "failure_balance_transaction": null,
  "reconciliation_status": "completed", "statement_descriptor": null, "livemode": true }
```
- **Status:**
  - `pending` → `in_transit` → `paid`, or `failed`/`canceled` within 5 business days.
  - "Some payouts that fail might initially show as `paid`, then change to `failed`." `payout.paid` only means "*expected* to be available".
- `failure_code` values include `account_closed`, `no_account`, `insufficient_funds`, `debit_not_authorized`, `could_not_process`, `invalid_account_number` and `declined`.
- `reconciliation_status`:
  - `completed`: you can list its transactions;
  - `in_progress`: soon;
  - `not_applicable`: "We only support this for standard automatic payouts".

**3.3 Transactions in a payout:** `GET /v1/balance_transactions?payout=po_…` (`balance_read`).
- **Params:** `payout` ("for automatic Stripe payouts only"), `type`, `source`, `currency`, `created`.
- `for await (const t of stripeRead.balanceTransactions.list({ payout: id, limit: 100 }))`
```json
{ "object": "list", "has_more": false, "data": [
  { "id": "txn_001", "object": "balance_transaction", "type": "charge", "reporting_category": "charge",
    "amount": 1000, "fee": 59, "net": 941, "currency": "usd", "status": "available",
    "available_on": 1678043844, "created": 1678043844, "source": "ch_001",
    "fee_details": [{ "amount": 59, "currency": "usd", "type": "stripe_fee", "description": "Stripe processing fees" }] },
  { "id": "txn_002", "type": "refund", "amount": -500, "fee": 0, "net": -500, "source": "re_001" },
  { "id": "txn_003", "type": "payout", "amount": -441, "net": -441, "source": "po_…" } ] }
```
- `net = amount - fee`. The `payout` row is the payout itself.
- Use `reporting_category` for accounting buckets.
- `source` stays an id unless expanded, and expanding needs `balance_transaction_source_read`. Instead, join it to the charges/refunds lists by their `balance_transaction` field.
- Calling this on a manual payout: error or empty list? **UNVERIFIED.** Gate on `reconciliation_status === "completed"`.

**3.4 Charges:** `GET /v1/charges`, `/v1/charges/{id}` (`charge_read`).
- **Params:** `created`, `payment_intent`, `customer`, `transfer_group`.
- A non-existent `customer` id raises an error.
```json
{ "id": "ch_3Mml…", "object": "charge", "amount": 1000, "amount_captured": 1000, "amount_refunded": 0,
  "currency": "usd", "created": 1679090539, "status": "succeeded", "paid": true, "refunded": false,
  "disputed": false, "payment_intent": "pi_3Mml…", "balance_transaction": "txn_3Mml…",
  "billing_details": { "name": "…", "email": "…" }, "receipt_email": null,
  "metadata": {}, "outcome": { "type": "authorized", "risk_level": "normal" },
  "payment_method_details": { "type": "card", "card": { "brand": "visa", "last4": "4242" } } }
```
- `status` values are `succeeded|pending|failed` (confirmed in the Charge object reference).
- **Search:** `GET /v1/charges/search?query=…` (for example `metadata['purpose']:'donation' AND created>…`).
  - Fields: `amount`, `created`, `currency`, `customer`, `disputed`, `metadata`, `refunded`, `status`, card `last4`/`brand`.
  - Max 10 clauses; can't mix AND and OR; pages with `page`/`next_page`.
  - Data shows up in search in "under 1 minute", so don't use it for read-after-write.

**3.5 PaymentIntents:** `GET /v1/payment_intents`, `/{id}`, `/search` (`payment_intent_read`).
- **Params:** `created`, `customer`, `customer_account`.
```json
{ "id": "pi_3Mtw…", "object": "payment_intent", "amount": 1000, "amount_received": 1000,
  "currency": "usd", "status": "succeeded", "created": 1680800504, "latest_charge": "ch_…",
  "metadata": { "purpose": "donation" }, "description": null, "client_secret": "pi_…_secret_…" }
```
- `status`: `requires_payment_method|requires_confirmation|requires_action|processing|requires_capture|canceled|succeeded`.
- **Drop `client_secret` before anything reaches the model or logs.**

**3.6 Refunds:** `GET /v1/refunds`, `/v1/refunds/{id}` (`charge_read`). Read only.
- **Params:** `charge`, `payment_intent`, `created`.
- A non-existent `charge` id raises an error.
```json
{ "id": "re_1Nis…", "object": "refund", "amount": 1000, "currency": "usd", "charge": "ch_…",
  "payment_intent": "pi_…", "balance_transaction": "txn_…", "created": 1692942318,
  "status": "succeeded", "reason": null, "metadata": {} }
```
- `status`: `pending|requires_action|succeeded|failed|canceled`. Live refunds are asynchronous and can succeed and later fail (`refund.failed`).
- Use this endpoint rather than `charge.refunds`. The list doc still says "The 10 most recent refunds are always available by default on the Charge object", but that line is out of date. The Charge object reference marks `refunds` as "includable (not returned by default; request it with the `expand` request parameter)".

**3.7 Disputes:** `GET /v1/disputes`, `/v1/disputes/{id}` (`dispute_read`).
- **Params:** `charge`, `payment_intent`, `created`.
```json
{ "id": "du_1MtJ…", "object": "dispute", "amount": 1000, "currency": "usd", "charge": "ch_…",
  "payment_intent": "pi_…", "created": 1680651737, "reason": "fraudulent",
  "status": "warning_needs_response", "is_charge_refundable": true, "balance_transactions": [],
  "evidence_details": { "due_by": 1682294399, "has_evidence": false, "past_due": false, "submission_count": 0 } }
```
- `status` values: `warning_needs_response`, `warning_under_review`, `warning_closed`, `needs_response`, `under_review`, `won`, `lost`, `prevented`.
- Jack should surface `due_by` loudly.
- `evidence` holds customer PII. Don't pass it to the model.

**3.8 (Optional) Checkout Session for a PaymentIntent:** `GET /v1/checkout/sessions?payment_intent=pi_…` (`checkout_session_read`). It returns `{ id: "cs_…", metadata: { paymentId, userId, eventId }, client_reference_id, payment_status, status }`.

**Errors.** stripe-node (`RequestSender.js`) picks the class from the HTTP status for 401, 403 and 429, and from the body's `type` for everything else (`Error.js`, `generateV1Error`). The body is `{ "error": { "type", "code", "message", "param", "doc_url", "request_log_url" } }`, plus a `Request-Id: req_…` header (`err.requestId`).

| HTTP | SDK class | When | Jack's handling |
|---|---|---|---|
| 400 / 404 | `StripeInvalidRequestError` (`type: invalid_request_error`) | Bad param, unknown id (`code: resource_missing`) | Say "not found". Don't retry |
| 401 | `StripeAuthenticationError` | Missing or invalid key (body `type: invalid_request_error`), or an **expired/rotated** key (body `type: authentication_error`) | Alert an officer. Tool disabled |
| 403 | `StripePermissionError` | RAK lacks the permission. Stripe's docs say the body's `type` is `invalid_request_error` and its message explains "which permissions to add". The wording is reportedly "Having the `rak_<perm>` permission would allow this request to continue" (**UNVERIFIED wording**, third-party reports only) | Log it. Never "fix" by widening the key automatically |
| 429 | `StripeRateLimitError` | Rate or concurrency limit (`Stripe-Rate-Limited-Reason`), or `lock_timeout` (a 429 without that header) | Back off with jitter. On a 429 the SDK retries only when `Stripe-Should-Retry: true` (sent for lock timeouts) |
| 5xx | `StripeAPIError` (`type: api_error`) | Stripe outage | The SDK retries 409 and 5xx unless `Stripe-Should-Retry: false`. Then show "Stripe unavailable" |
| 409 | Depends on `type`, for example `StripeIdempotencyError` | Conflict. Unlikely for GETs, which carry no idempotency key | Same as 5xx |
| none | `StripeConnectionError` | Network | The SDK retries |

## 4. Webhooks/events
**Existing endpoint.** `we_1T22…` → `/api/stripe/webhook` gets `checkout.session.*` and `charge.refunded`, verified with `webhooks.constructEvent` in `payment.service.ts`. To push money events into Jack's cache instead of polling, Gray would add these events in the Dashboard (a shared-system change that needs his OK):
- `payout.paid`, `payout.failed`, `payout.canceled` (the payout);
- `payout.reconciliation_completed` (the payout; its transactions are now listable);
- `charge.dispute.created` / `.closed` / `.funds_withdrawn` (the dispute);
- `refund.failed` (the refund);
- optionally `balance.available` (the balance).

The handler records each event and returns 2xx fast. Events carry the object "in their minimal form" (no expansions), so re-fetch with the RAK if more detail is needed.

**Verification, exactly:**
- Header: `Stripe-Signature: t=1492774577,v1=<hex>,v0=<hex>`, all on one line.
- Split on `,` then on `=`. Keep `t` and **every** `v1`. Ignore `v0` (fake test scheme) and any other scheme, to prevent downgrade.
- `signed_payload = t + "." + rawBody`, where `rawBody` is the exact UTF-8 bytes, unparsed.
- `expected = hex(HMAC_SHA256(key = endpoint secret "whsec_…", msg = signed_payload))`.
- Constant-time compare against each `v1`. Reject if `|now - t|` exceeds the tolerance. The SDK default is 300 s (`DEFAULT_TOLERANCE`), and **never use 0** (Stripe: "Using a tolerance value of `0` disables the recency check entirely"). In stripe-node 20.4.1, `constructEvent` turns a 0 into 300 (`tolerance || DEFAULT_TOLERANCE`), so the trap is in hand-rolled verifiers and fakes, and in calling `signature.verifyHeader` directly.
- While a secret is being rolled (up to 24 h), each header carries one `v1` per active secret.
- Live and test endpoints have different secrets, and so does `stripe listen`.

**Delivery:**
- Stripe retries for up to 3 days with backoff in live mode, but only 3 times over a few hours in a sandbox.
- No ordering guarantee and possible duplicates: dedupe on `event.id`, or on `data.object.id` + `type`.
- Dashboard resend works for 15 days; CLI `stripe events resend` for 30.
- 3xx counts as failure, and live mode needs HTTPS (TLS 1.2+).

**Event object:** `{ id: "evt_…", object: "event", api_version, created, type, livemode, pending_webhooks, request: { id, idempotency_key }, data: { object, previous_attributes? } }`.

## 5. Rate limits and quotas, plan limits, data retention
- **Rate:**
  - 100 req/s global in live mode, 25 req/s in a sandbox.
  - 25 req/s per endpoint unless noted; search 20 req/s; files 20 req/s.
  - Live concurrency is 50 in-flight requests. List and expand calls are the heavy ones.
  - The Payouts API also has its own limit of 30 concurrent requests.
- **Read allocation (the one that can bite us):**
  - Reads may not exceed **an average of 500 GET requests per transaction over a rolling 30 days**, with a **minimum of 10,000 reads/month** per account. Writes have no allocation.
  - The floor is the binding limit only when we process fewer than 20 transactions in 30 days. Above that, the allowance is 500 × transactions (for example, 60 LSC entries in a month allow 30,000 reads). Plan for the floor, since quiet months happen.
  - Example: a 15-minute poll making 5 calls is ~14,400/month, which is over the floor. A daily sync (~10–20 calls) plus on-demand tool calls (cap them, for example at 300/day) stays well under.
  - Prefer webhooks to polling.
- **Plans:** no API tiers or paid quota. API use costs nothing; Stripe charges per transaction.
- **Retention:**
  - `GET /v1/events` only reaches back **30 days**.
  - How long charges, payouts and balance transactions stay listable has no documented limit that we found (**UNVERIFIED**; in practice they stay).
  - Cache what Jack reports in our DB so answers stay stable.

## 6. Gotchas, policy/terms, privacy
- **Joining Stripe to members:**
  - Charges and PaymentIntents don't carry `paymentId`, because only the Checkout Session has it.
  - **Already handled:** the existing `checkout.session.completed` handler stores `session.payment_intent` in `Payment.providerRef` when it claims the payment (`claimPayment` in `payment.service.ts`), and `charge.refunded` already joins on it. Jack joins `charge.payment_intent` → `Payment.providerRef` with no extra Stripe permission.
  - **Fallback:** grant `checkout_session_read` and look the session up by `payment_intent`. That's only needed for rows still holding a `cs_…` id (pending or expired, which have no charge anyway).
  - Donations have no `Payment` row at all. Classify them by `metadata.purpose`.
- **Expand needs permissions too.** `expand[]=data.source` on balance transactions needs `balance_transaction_source_read`, which drags in transfer/payout/fee reads. Avoid it.
- **Payout reconciliation** only works for **standard automatic** payouts. Manual payouts are `not_applicable`; "You're responsible for reconciling" them.
- **Dates:**
  - `arrival_date` in the docs example is exactly 00:00 UTC (1680652800). Render it as a UTC calendar date, or the day shifts in Central time (inferred, **UNVERIFIED** as a rule).
  - Other timestamps are Unix seconds.
- **No in_transit filter** on list payouts. Fetch recent ones and filter locally.
- **Never act:**
  - The key has no Write. Even so, Jack's tool layer should expose only `list`/`retrieve` wrappers, never the raw client.
  - Duplicates or refund needs get flagged to an officer, never actioned (memory: no auto-refunds).
- **PII:**
  - Charges carry `billing_details` (name, email, address), `receipt_email`, card brand/last4/fingerprint and `receipt_url`.
  - Disputes carry `evidence` (customer name, email, IP, addresses).
  - Jack may read app PII (Gray's call), but the Stripe tool should **project to an allowlist**: id, amount, currency, status, created, name/email for matching, and metadata. Drop `client_secret`, `fingerprint`, addresses and `evidence`.
  - Treat RAKs like secret keys. Never put one in client code, prompts or logs.
- **Test vs live:**
  - Objects in one mode aren't visible to the other, and every object carries `livemode`.
  - Assert `livemode === (VERCEL_ENV === "production")` on responses.
  - The claude.ai Stripe connector is live-only.
- **Search** isn't available to businesses in India (not us). Its results can show a newer `status` than the one matched.

**Test-mode restricted keys for local dev:**
- Create `jack-read-test` (`rk_test_…`) with the same permissions, in the test-mode sandbox that `scripts/payments-smoke.ts` (`STRIPE_TEST_SECRET_KEY`) already writes to, so smoke-test charges and refunds are visible.
- Sandbox keys can be revealed any time. Stripe recommends separate general sandboxes for new integrations and CI.
- **Seed data** with the smoke script or the `sk_test_` key, **never** Jack's key:
  - Card `4000000000000077` (`pm_card_bypassPending`) puts funds straight into **available**.
  - `4000000000000259` makes a fraud dispute synchronously; `4000000000001976` makes an inquiry.
  - Put `winning_evidence` or `losing_evidence` in `uncategorized_text` to close a test dispute.
  - `4000000000005126` makes a refund that later fails.
  - Test payout bank accounts use routing `110000000`: `000123456789` succeeds, `000111111116` fails with `no_account`, `000111111113` with `account_closed`, `000222222227` with `insufficient_funds`.
- Whether sandbox **automatic** payouts run on a schedule (needed to test `payout=` reconciliation for real) is **UNVERIFIED**. Rely on the fake for that path.

## 7. How to fake it locally
- **Make the fake an HTTP server, not a mocked client.** Run something like `scripts/fakes/stripe.ts` on `127.0.0.1:12111` and point the real SDK at it with `host`/`port`/`protocol: "http"`. That way SDK parsing, auto-pagination, error classes and retries are all exercised.
- **Why not stripe-mock:** `stripe/stripe-mock` (Docker, ports 12111/12112) is stateless, returns canned fixtures, and is locked to the latest API version. It rejects unknown or mistyped params, but it can't be made to return a chosen error (its README: "It will return a success response instead of the desired error response"), so there's no 403, 404 or 429 to test against. That's too thin for this.
- **Auth:**
  - Expect `Authorization: Bearer rk_test_…`.
  - Missing or unknown key → 401 `{error:{type:"invalid_request_error", message:"Invalid API Key provided: …"}}`. The exact message is **UNVERIFIED**.
  - A configurable "expired" key → 401 with `type: "authentication_error"` (Stripe's docs give that type for expired keys).
- **Permissions:**
  - Each fake key has a grant set (default: the five Reads above).
  - Map each route to its permission id per §2.
  - Missing grant, and **any POST/DELETE**, → 403 `invalid_request_error` whose message names the `rak_<perm>`. This is how we prove Jack never writes.
- **Lists:**
  - Exact envelope (`object`, `url`, `has_more`, `data`).
  - `limit` 1–100 (default 10; out of range → 400 `param: "limit"`).
  - `starting_after` XOR `ending_before`. Sort newest first by `created`, then id.
  - Accept both `expand[]=` and `expand[0]=`, and `created[gte]` style ranges.
- **Retrieve:** an unknown id → 404 `{type:"invalid_request_error", code:"resource_missing", param:"id", message:"No such payout: 'po_x'"}`. The message format is from experience, **UNVERIFIED**.
- **Filters:**
  - payouts: `status` (rejecting `in_transit`), `arrival_date`, `created`;
  - balance_transactions: `payout` (only for `automatic: true` payouts with `reconciliation_status: "completed"`), `type`, `source`;
  - charges, refunds, disputes: by `charge`/`payment_intent`;
  - optional `/v1/charges/search` with `metadata['k']:'v'` and `created>` only.
- **Headers:** `Request-Id: req_…` on every response. A switch to return 429 with `Stripe-Rate-Limited-Reason: global-rate`, and 500 with `Stripe-Should-Retry: true`, to test backoff.
- **Consistent fixtures** (`livemode: false`):
  - LSC entries ($10/$5) whose PaymentIntents link to Checkout Sessions with `metadata.paymentId`;
  - a donation (`metadata.purpose: donation`);
  - a partial refund and a failed refund;
  - a `warning_needs_response` dispute with `due_by` in 3 days;
  - payouts in `pending`, `in_transit`, `paid` and `failed` (`failure_code: "no_account"`), plus one manual payout (`automatic: false`, `reconciliation_status: "not_applicable"`).
  - For each automatic paid payout, Σ`net` of its non-payout transactions must equal `payout.amount`, and its `payout` transaction's `amount` must be `-payout.amount`.
  - `balance` must match the pending/available split of the fixture transactions.
- **Webhook sender:** a `fake:stripe-event <type>` command that POSTs a signed event to `/api/stripe/webhook`. Sign it with `stripe.webhooks.generateTestHeaderString({ payload, secret })`, which exists in 20.4.1, or by the §4 recipe.
- **Shape check:** a unit test that validates the fixtures against Stripe's OpenAPI spec (`github.com/stripe/openapi`, at the SDK's `OPENAPI_VERSION`, `v2186`) catches drift. Suggested, not required.

## 8. Sources
- Keys: https://docs.stripe.com/keys/restricted-api-keys, https://docs.stripe.com/keys, https://docs.stripe.com/keys/permissions-reference, https://docs.stripe.com/stripe-apps/reference/permissions
- Balance and payouts: https://docs.stripe.com/api/balance/balance_object, https://docs.stripe.com/api/payouts/list, https://docs.stripe.com/api/payouts/object
- Balance transactions: https://docs.stripe.com/api/balance_transactions/list, https://docs.stripe.com/api/balance_transactions/object
- Charges and PaymentIntents: https://docs.stripe.com/api/charges/list, https://docs.stripe.com/api/charges/object, https://docs.stripe.com/api/payment_intents/list, https://docs.stripe.com/api/payment_intents/object
- Refunds and disputes: https://docs.stripe.com/api/refunds/list, https://docs.stripe.com/api/refunds/object, https://docs.stripe.com/api/disputes/list, https://docs.stripe.com/api/disputes/object
- Checkout Sessions and events: https://docs.stripe.com/api/checkout/sessions/list, https://docs.stripe.com/api/events/list, https://docs.stripe.com/api/events/types
- https://docs.stripe.com/payouts/reconciliation
- https://docs.stripe.com/expand
- https://docs.stripe.com/api/pagination and https://docs.stripe.com/pagination
- https://docs.stripe.com/search
- https://docs.stripe.com/rate-limits
- https://docs.stripe.com/api/errors and https://docs.stripe.com/error-handling?lang=node
- https://docs.stripe.com/api/versioning and https://docs.stripe.com/sdks/set-version
- https://docs.stripe.com/webhooks and https://docs.stripe.com/events/manage-webhook-endpoints
- https://docs.stripe.com/sandboxes, https://docs.stripe.com/testing and https://docs.stripe.com/connect/testing
- https://github.com/stripe/stripe-node (README) and the installed `node_modules/stripe` 20.4.1 source (`apiVersion.js`, `RequestSender.js`, `autoPagination.js`, `Webhooks.js`, `utils.js`)
- https://github.com/stripe/stripe-mock
- https://docs.stripe.com/account/approvals (agent-key approval rules) and https://docs.stripe.com/metadata (how metadata is copied between objects)
- Vercel: https://vercel.com/docs/networking/static-ips and https://vercel.com/kb/guide/can-i-get-a-fixed-ip-address
- Third-party, for the 403 message format only: https://fivetran.com/docs/connectors/applications/stripe/troubleshooting/rak_event_read_permission and https://discuss.streamlit.io/t/st-paywall-permissionerror/54963

## Checked
Second pass on 10/22 against the Markdown versions of the Stripe pages above (`docs.stripe.com/<path>.md`), the installed stripe-node 20.4.1 source, and our own `payment.service.ts`.

**Verified, no change needed:**
- Keys: the RAK prefixes and the None/Read/Write model; that Write implies Read and every API supports RAKs; the agent-key quote; that a live RAK can't be revealed again; the 7-day rotation grace period; the 180-day limited access; and the Advanced access policy rules, including ASN 16509 in Stripe's own example.
- Permissions table: every endpoint-to-permission row except PaymentIntent retrieve, and the `webhook_read` "sensitive permission" wording.
- Endpoints, all GET:
  - Paths and list params for balance, payouts, balance transactions, charges, PaymentIntents, refunds, disputes and Checkout Sessions.
  - Payout statuses, the 5-business-day rule, "might initially show as `paid`", the `failure_code` values and the `reconciliation_status` meanings.
  - Dispute, refund and PaymentIntent status enums; that unknown `customer` or `charge` filters raise errors; and the balance object's fields.
- Search: the 10-clause limit, no mixing AND with OR, `page`/`next_page`, indexing "under 1 minute", 20 reads/s and the India exclusion.
- Rate limits: 100/25 req/s global, 25 per endpoint, 50 concurrent, the `Stripe-Rate-Limited-Reason` values, `lock_timeout`, and the 500-per-transaction read allocation with its 10,000 floor.
- Webhooks:
  - The signature format and steps, ignoring `v0`, constant-time compare, the 5-minute default and the "never 0" warning.
  - The 24 h secret roll, 3-day live retries versus 3 retries in a sandbox, 15/30-day resend, 3xx counted as failure, TLS 1.2+, no ordering, and the dedupe advice.
  - Minimal-form objects and the 30-day events window.
  - The descriptions of each proposed event type, including `payout.paid` meaning "*expected*".
- Versioning: the monthly and twice-yearly majors model; `2026-09-30.endive` is current; stripe-node v12+ pins its version; the `apiVersion` override "might cause inaccurate Typescript types"; and webhook versions.
- SDK:
  - 20.4.1 pins `2026-02-25.clover` and uses `maxNetworkRetries` 2 in code (the README says 1), an 80 s timeout and a `telemetry` option.
  - `autoPagingToArray` requires `limit` and caps it at 10,000. Lists given `ending_before` page backwards.
  - Arrays encode as `expand[0]=`, `generateTestHeaderString` exists, and `OPENAPI_VERSION` is `v2186`. `src/lib/stripe.ts` sets no `apiVersion`.
- Testing: card numbers 0077, 0259, 1976 and 5126; `winning_evidence`/`losing_evidence`; the US payout test bank accounts (from the Connect testing page); and the sandbox advice.

**Corrected:**
- §1, §2, §6: `Payment.providerRef` doesn't stay `cs_…`. `claimPayment` already overwrites it with `session.payment_intent` on success, and `charge.refunded` already joins on it. So "Option 1" was already built, and `checkout_session_read` isn't needed for joins.
- §1: added Stripe's metadata copy rules (a link's `metadata` reaches only its Checkout Sessions; `payment_intent_data.metadata` reaches the PaymentIntent, then a one-time copy goes to the Charge). Also added Checkout Sessions' `payment_link` filter.
- §2: `balance_transaction_source_read` also implies Balance (Read).
- §2: Vercel does sell fixed egress IPs: the Static IPs add-on (Pro/Enterprise, $100/month per project, a shared pool). By default it publishes no IP range.
- §3 errors: the SDK picks the class by HTTP status only for 401, 403 and 429, and otherwise by the body's `type`. So a 409 isn't always `StripeAPIError`. Also noted that a 403 body has `type: invalid_request_error` and that an expired key's 401 has `type: authentication_error`.
- §3.2: flagged that the payout JSON is an edited docs sample.
- §4: noted that stripe-node's `constructEvent` turns a 0 tolerance into 300.
- §5: the 10,000 floor binds only below 20 transactions per 30 days. Added the Payouts API's 30-concurrent limit.
- §7: stripe-mock does reject bad params; what it can't do is return a chosen error response.

**UNVERIFIED items now resolved:**
- Agent-key tagging doesn't affect reads.
- The Charge `status` enum.
- `charge.refunds` is not returned without `expand`.
- That a RAK missing a permission gets a body naming the permission to add (Stripe's RAK guide). Only the exact wording stays third-party.

**Still UNVERIFIED:**
- Whether `payment_intent_read` covers `GET /v1/payment_intents/{id}` (absent from the permissions table).
- The exact Dashboard labels.
- Whether Vercel functions egress from AWS ASN 16509.
- What `balance_transactions?payout=` does for a manual payout.
- The exact 401, 403 and 404 message strings.
- How long charges and payouts stay listable.
- Whether sandbox automatic payouts run on a schedule.
- Whether `arrival_date` is always midnight UTC.
- That donation charges actually carry `metadata.purpose` (check one live charge).
