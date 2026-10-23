Docs and env notes for the sources-a track; folded into docs/jack.md at the end.

# Sources A: Stripe, email delivery and site traffic (T4)

Design §12.3–§12.5 and §13. Three outside services, each read only, each copied into the club's own tables so Jack and the console read the copies: Stripe (a daily sync plus payout and dispute webhooks), Resend delivery events (a webhook) and site traffic (a daily snapshot of Vercel Web Analytics). Code paths are relative to `apps/platform/`. Like every 2.0 connector, all three ship switched off.

## What's where

| Piece | Where |
|---|---|
| Stripe read client (only list and retrieve calls; restricted key; 20 s timeout) | `src/server/connectors/stripe/client.ts` |
| Stripe connector, smoke test, Connections details | `src/server/connectors/stripe/connector.ts` |
| Stripe sync (balance, payouts and their contents, charges with fees, refunds, disputes) | `src/server/connectors/stripe/sync.ts` |
| Stripe writes, shared by the sync and the webhook | `src/server/connectors/stripe/store.ts` |
| Stripe reads for the panel and the tool | `src/server/connectors/stripe/read.ts` |
| Stripe fake | `src/server/connectors/stripe/fake/` |
| `payout.*` and `charge.dispute.*` on the existing webhook | `src/server/services/payment.service.ts` (`handleStripeWebhook`) |
| Resend webhook route | `src/app/api/webhooks/resend/route.ts` |
| Resend verification and parsing | `src/server/connectors/resend/webhook.ts`, `svix.ts` |
| Delivery status and reads | `src/lib/email-delivery.ts` (pure), `src/server/connectors/resend/delivery.ts` |
| Resend connector and fake | `src/server/connectors/resend/connector.ts`, `fake/handlers.ts` |
| Site traffic client (two GET paths only), snapshot, reads | `src/server/connectors/site-traffic/` |
| Site traffic fake (synthetic page views, OData filter subset) | `src/server/connectors/site-traffic/fake/` |
| Jobs `stripe.sync`, `site-traffic.snapshot`, `email-events.prune` | `src/server/scheduler/jobs/sources-a.ts` |
| Tools `stripe_overview`, `email_delivery`, `site_traffic` (deferred) | `src/server/jack/tools/stripe-overview.ts`, `email-delivery.ts`, `site-traffic.ts` |
| Digest check `email.bounces` | `src/server/automation/checks/sources-a.ts` |
| Stripe panel on Money → Payments | `src/app/admin/payments/_components/stripe-panel.tsx` |
| Delivery column and Delivery tab on System → Notifications | `src/app/admin/notifications/_components/notification-activity.tsx`, `notification-delivery.tsx` |
| Delivery column on Recruiting → Emails | `src/components/admin/recruiting/emails-console.tsx` |
| Site traffic card on the Overview | `src/app/admin/_overview/cards/sources-a.tsx` |
| DB check | `scripts/check-sources-a.ts` |

## Stripe (connector `stripe`)

- **Key:** `STRIPE_READONLY_KEY`, a restricted key (`rk_…`), separate from the checkout key (`STRIPE_SECRET_KEY`), which this code never uses. The client refuses anything that isn't `rk_`, and a live key (`rk_live_`) outside Vercel production. Every response's `livemode` must match the environment (test data never lands in production's tables, or the other way round). The SDK client never leaves `client.ts`: callers get list and retrieve calls only.
- **Sync** (`stripe.sync`, daily at 5 AM CT, inline, 2 minutes): the balance (one `StripeBalanceDaily` row per Chicago day), payouts, charges, every balance transaction (each charge's fee and net), the contents of each paid automatic payout (which charges it paid out), refunds and disputes. It looks back 120 days, 400 on its first run (the cursor records `backfilledAt` once a first run finishes; it never holds a key). About ten reads a run plus one per newly paid payout, far inside Stripe's read allowance (at least 10,000 a month). Every write is an upsert, so reruns change nothing. A step that fails is reported and the rest still run; the run then fails with what went wrong (recorded on the connector).
- **Webhook:** the existing `/api/stripe/webhook` now also stores `payout.created|updated|paid|failed|canceled|reconciliation_completed` and `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`, through the same writes as the sync. Each write carries when its data is from (the event's `created`, or when the sync asked), and an older copy never replaces a newer one (`saveNewest`; the DB check covers two writers at once). Nothing else in the handler changed. These events are stored whether or not the connector is switched on: they're Stripe's own signed messages about the club's account.
- **New table `StripeCharge`** (migration `20261024004000_jack2_stripe_charges`, additive): a charge's amount, refunded amount, status, disputed flag, `purpose` (metadata, `donation` for the donation link), fee, net and `payoutId`. No card, billing or customer details. `paymentIntentId` joins `Payment.providerRef`, the way the webhook already finds payments. The design's tables had nowhere to keep a payout's contents or a Payment's Stripe side, which the design's "payouts with their balance transactions" and "Payment joined to Stripe charges" need.
- **Where officers see it:** Money → Payments gets a Stripe panel (first page only): available and pending balance, the next payout, open disputes, then recent payouts, refunds and disputes. A dispute that needs a response gets a red notice with its due date and a link to respond in Stripe, and the payment it's on gets a "Disputed" badge in the list. Payout arrival dates are shown as UTC calendar days (they're midnight UTC; Central time would say the day before).

## Resend delivery events (connector `resend`)

- **Webhook:** `POST /api/webhooks/resend`. The raw body is read first and verified with `resend.webhooks.verify()` (Svix: HMAC-SHA256 over `id.timestamp.body`, constant-time, a 5-minute window, either signature during a secret rotation). Without `RESEND_WEBHOOK_SECRET` every request gets 503 (fail closed; Resend retries for about a day). Each event is stored once per `svix-id` in `EmailEvent` (a retry is a no-op answered 200). Events other than `email.*` are acknowledged and dropped. Nothing logs a body, an address or the secret.
- **What's kept:** the Resend email id, the recipient, the type, the event's time, and a small detail: a bounce's type and message, a failure's reason, a suppression's type, or a clicked link without its query string. Never a click's IP address or browser. Kept 12 months (`email-events.prune`, daily; the privacy page says delivery logs are kept up to a year).
- **Status is worked out when read, from all of an email's events** (they arrive in any order): complained, bounced, failed, suppressed, clicked, opened, delivered, delayed, sent, strongest first (`src/lib/email-delivery.ts`).
- **No read key:** Resend's API is never called; the production key stays send-only. The connector's "last sync" is the last event stored, and its smoke test checks the secret and reports when the last event was stored.
- **The switch:** switched off, the webhook keeps nothing. It still checks the signature, then answers 200 `{ ok: true, stored: false }` without storing, so Resend counts the event as delivered and neither retries it nor disables the endpoint. Events sent while it's off are gone for good (there's no read key to fetch them later). Jack's `email_delivery` then says it isn't connected and answers only from what was stored before, and Notifications → Delivery says tracking is switched off. Nothing is stored before an admin switches it on, so no member address is collected just because the secret is set.
- **Where officers see it:** System → Notifications gets a Delivery column on Activity (and the delivery in each row's details) and a **Delivery** tab: the last 30 days' outcomes and the addresses that didn't get our email in the last 90 days, with the member, the email that failed, the reason and whether a later email arrived. The tab streams in after the rest of the page, so Activity never waits for it: its badge is one grouped count, and the outcomes are counted in the database (one row per status), not by loading every event. If its reads fail it shows a warning, never zeros. Recruiting → Emails gets a Delivery column and lists sent recruiting emails that bounced or are delayed, plus a one-line summary for the round, and a one-line warning when the reports couldn't be read.
- **Digest check** `email.bounces` (order 70): addresses with mail that didn't arrive in the last 7 days, grouped by the email (never an address in the items); danger when someone marked club mail as spam. Links to `/admin/notifications?tab=delivery`.

## Site traffic (connector `site-traffic`)

- **Token:** `VERCEL_ANALYTICS_TOKEN`, a project-scoped Vercel token, and `VERCEL_ANALYTICS_PROJECT_ID`. Vercel has no read-only token (design §12.5, an exception for Gray's sign-off), so the client can only ever send GETs to `/v1/query/web-analytics/visits/aggregate` and `/count`, checked in code before any request (`assertSiteTrafficPath`). It never follows a redirect (`redirect: "manual"`, and any 3xx is an error), so the token can't be carried to another path.
- **Snapshot** (`site-traffic.snapshot`, daily at 3:30 AM CT, inline): every complete UTC day of the last 29 that isn't stored yet (so the first run backfills Hobby's month), five reads a day: the day's page views and visitors (`total`), and its top 100 pages, referrers, countries and devices. A day's rows are replaced together. 402 (outside the plan's window) skips a day; 429 stops and leaves the rest for the next run; 401/403/404 fail the run with a hint.
- **Public pages only:** every query sends `environment eq 'production' and not startswith(requestPath,'/admin')` (`PUBLIC_PAGES_FILTER`). Officers browse the console all day, and it would swamp the club's real traffic. This follows Vercel's documented OData filters but hasn't met the live API yet: if the smoke test answers 400 about the filter, that constant is the one line to change.
- **Counting:** days are UTC (each starts at 7 PM Central the evening before, 6 PM in winter); `SiteTrafficDaily` says so. Vercel counts a visitor once a day, so a range's visitors are shown as a daily average ("visitors a day"), never added up as people.
- **Where officers see it:** a Site traffic card on the Overview (the latest 7 stored days against the 7 before, and the top pages). It shows nothing until a snapshot exists. Page paths come from outside (anyone can send events to Vercel's analytics), so only a plain path on this site (`/x`, not `//host`, `/\host` or anything with whitespace) is a link; anything else is text.

## Jack

- **Tools** (all deferred, found through tool search, read only): `stripe_overview` (summary, or one kind listed for a window, or one payout charge by charge), `email_delivery` (sends grouped by title and day with their outcomes, one email's events, one named recipient's mail, bounces), `site_traffic` (by day, or the top pages/referrers/countries/devices, a page day by day, compared with the period before). Each says whether its source is connected and how fresh its data is; switched off with data stored, it still answers from what's stored and says so; never synced, it says it isn't connected.
- **Recruiting privacy (design §3.2):** in `email_delivery`, a recruiting email to an applicant who is an officer or admin shows only that it was a recruiting email (its subject and template would give a decision away), and such applications are left out of the recruiting counts. The console shows officers everything.
- **Prompt** (`prompt-sections/sources-a.ts`): when to use the tools, Stripe is read only for Jack, look up one person's email only when an officer named them, UTC days and per-day visitors. Three page lines (Payments' Stripe panel, Notifications → Delivery, the Overview's traffic card).
- **Schema notes** for all seven tables (`schema-notes-slots/sources-a.ts`).
- **Eval** (`scripts/jack-eval/tracks/sources-a.ts`, fake data in `seed/sources-a.ts`): the Stripe balance, a failed payout and why, a dispute's due date, last week's bounces, the top page, and this week's page views against last week's. The seeders run the Stripe sync and the traffic snapshot against the fakes, and store made-up delivery events (resend.dev addresses) through the webhook's own parsing.

## Env vars

| Name | Where | What |
|---|---|---|
| `STRIPE_READONLY_KEY` | Vercel Production (Sensitive): `rk_live_…`; locally and Preview: `rk_test_…` | Jack's restricted Stripe key (permissions below) |
| `RESEND_WEBHOOK_SECRET` | Vercel Production (Sensitive) | The Resend webhook's signing secret (`whsec_…`) |
| `VERCEL_ANALYTICS_TOKEN` | Vercel Production (Sensitive) | Project-scoped token for the LSR project, short expiry |
| `VERCEL_ANALYTICS_PROJECT_ID` | Vercel Production | The project's id (`prj_…`, Project → Settings) |
| `RESEND_BASE_URL` | `.env.local` only | `http://127.0.0.1:3999/resend` to send the app's email to the fake (the SDK reads it once, at load) |

All four production names were already in `.env.example` and `SECRET_ENV_VARS` (G1).

## Setup (Gray)

**Stripe**
1. Dashboard → Developers → API keys → **Create restricted key**, named `jack-read`. Set **Read** on Balance, Payouts, Charges (covers refunds) and Disputes; everything else None, every Write off. (PaymentIntents, Checkout Sessions and Events aren't used.) Optionally tag it as an agent key. Copy it (a live restricted key can't be shown again).
2. Vercel → the project → Environment Variables → `STRIPE_READONLY_KEY`, Production only, Sensitive. Redeploy.
3. Stripe → Developers → Webhooks → the existing endpoint (`/api/stripe/webhook`) → add events: `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, `payout.reconciliation_completed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`. The secret doesn't change.
4. System → Connections → Stripe → **Run smoke test** (reads the balance, payouts, charges and disputes of the last 30 days). Then switch it on, and switch on `stripe.sync` on Scheduled jobs. The first run looks back 400 days.

**Resend**
1. Resend → Webhooks → **Add webhook**: `https://www.longhornsimracing.org/api/webhooks/resend` (the exact production host: a redirect counts as a failure). Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Leave opened and clicked off unless open/click tracking is turned on for the domain (a privacy choice; update the Resend line on `/privacy` first).
2. Copy the signing secret into Vercel as `RESEND_WEBHOOK_SECRET` (Production, Sensitive). Redeploy.
3. Connections → Resend → **Run smoke test**: it checks the secret (and says the connector is off). Then, in one step, switch Resend on and switch on `email-events.prune` on Scheduled jobs: nothing is stored until it's on, and the prune keeps the 12-month promise from then on.
4. Send any email (a test notification to yourself) and run the smoke test again: it should say when the last event was stored.
5. To stop collecting, switch Resend off: events are then acknowledged and dropped. Deleting the webhook in Resend's dashboard stops them being sent at all.

**Site traffic**
1. Logged in as the account that owns the LSR Vercel team (Gray's own login can't see it): Account Settings → Tokens → **Create**: scope the LSR team → the project, an expiry (a year at most; put a reminder in the calendar a week before), name `lsr-site-traffic`.
2. Vercel → the project → Environment Variables: `VERCEL_ANALYTICS_TOKEN` (Production, Sensitive) and `VERCEL_ANALYTICS_PROJECT_ID` (Production). Web Analytics must be on for the project. Redeploy.
3. Connections → Site traffic → **Run smoke test** (yesterday's page views and top pages). If it answers 400 about the filter, see `PUBLIC_PAGES_FILTER` above. Then switch it on and switch on `site-traffic.snapshot`; its first run fills the last 29 days.
4. When the token expires, the snapshot fails with "make a new project-scoped token": repeat 1 and 2.

## Trying it locally (fakes only, nothing paid)

1. `pnpm --filter @lsr/platform jack:fakes` (or `--port 4132` with `JACK_FAKES_URL=http://127.0.0.1:4132`). `GET /` lists the Stripe, Resend and site traffic fakes.
2. In `.env.local`: `JACK_FAKES=all`, `STRIPE_READONLY_KEY=rk_test_jackfakereadonly0000000001`, `VERCEL_ANALYTICS_TOKEN=vcp_jackfakesitetraffic000000000001`, `VERCEL_ANALYTICS_PROJECT_ID=prj_jackfakeproject01` (the fakes' own made-up credentials), and for the webhooks `STRIPE_WEBHOOK_SECRET` (any `whsec_…`), `RESEND_WEBHOOK_SECRET` (`whsec_` + base64 of 32 bytes) and `RESEND_BASE_URL=http://127.0.0.1:3999/resend`.
3. Switch Stripe, Resend and Site traffic on (Connections, as an admin; the Resend webhook stores nothing while Resend is off), then `pnpm --filter @lsr/platform jack:tick --job stripe.sync` and `--job site-traffic.snapshot`. Switch them off again afterwards: the local database is shared.
4. Webhooks, with the dev server running: `curl -X POST http://127.0.0.1:3999/stripe/_fake/events -d '{"type":"payout.paid","target":"http://localhost:3000/api/stripe/webhook"}'` (also `payout.failed`, `charge.dispute.created`, `charge.dispute.closed`). For Resend, send email through the app (or `POST /resend/emails` on the fake), then `curl -X POST http://127.0.0.1:3999/resend/_fake/webhooks -d '{"target":"http://localhost:3000/api/webhooks/resend"}'`; `"duplicate": true` and `"outOfOrder": true` exercise dedupe and ordering. Outcomes follow Resend's test inboxes: `delivered@`, `bounced@`, `complained@`, `suppressed@resend.dev`, plus `delayed@` and `clicked@` (`+labels` allowed).
5. Pages: Money → Payments (the Stripe panel), System → Notifications (Activity's Delivery column, the Delivery tab), Recruiting → Emails, the Overview's Site traffic card. `pnpm --filter @lsr/platform exec tsx scripts/try-jack-tools.ts` prints what the three tools return.
6. `pnpm --filter @lsr/platform exec tsx scripts/check-sources-a.ts` checks the database side (it writes only rows it deletes).

## Release steps

1. The migration `20261024004000_jack2_stripe_charges` goes to production with the other 2.0 migrations, before the code (design §17).
2. After the merge: the setup steps above, each connector switched on only after its smoke test passes, then its job.

## Not verified live (fakes only so far)

- Stripe: that the Dashboard's labels match the permission list above; that `balance_transactions?payout=` behaves as the research says for a manual payout (the sync never asks: it only reads paid automatic payouts).
- Resend: the exact shape of a real bounce's `bounce.message` (stored capped at 300 characters).
- Vercel: the OData filter above, the real "Others" row, whether `count` with exact ms bounds counts the UTC day as expected, `deviceType` casing and the `country` format. The first real snapshot shows them; adjust the fake if they differ.

## Noticed, not changed

- The existing `/api/stripe/webhook` route logs the whole error on a bad signature, and Stripe's signature error carries the raw payload, so a forged or misrouted event's body ends up in the function log (true for every event type before this PR too). A follow-up could log only the error's message.
