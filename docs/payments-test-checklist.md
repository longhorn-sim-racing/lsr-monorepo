# Payments test checklist

Run this before merging anything that touches `payment.service.ts`, `/api/checkout`,
`/api/stripe/webhook`, or the membership / Lone Star Cup pages. Link the run from the PR.

**Local:** `stripe listen --forward-to localhost:3000/api/stripe/webhook` and put the
printed `whsec_…` in `.env.local` as `STRIPE_WEBHOOK_SECRET`.
**Preview:** the test-mode endpoint in the Stripe dashboard points at the preview URL.
**Card:** `4242 4242 4242 4242`, any future expiry, any CVC.

`stripe trigger …` sends synthetic objects without our `paymentId` metadata, so the
handlers ignore them by design. Drive the real objects instead, as noted in steps 6–8.

| # | Do | Expect |
|---|---|---|
| 1 | Fresh user → `/account` → **Pay dues** | Redirect to Stripe. `Payment` row is `pending` with `productId` set. |
| 2 | Complete the payment | Back on `/account?payment=success`. After the webhook: `Payment` `succeeded`; `Entitlement` `lsr_member` valid to Jul 31; `UserMembership` `LSR_MEMBER` active; `AuditLog` `PAYMENT_SUCCEEDED`; in-app + email `DUES_CONFIRMED`; member badge shows. |
| 3 | Same user → **Pay dues** again | `400` "Your LSR membership is already active." |
| 4 | New user → `/lone-star-cup` → **Enter** | Goes to `/lone-star-cup/enter`. Submitting the form saves a `LeagueApplication` for the open season, then opens Stripe. Calling `/api/checkout` for `LEAGUE_FEE` without a form → `400` "Fill out the entry form before paying." With **Require paid LSR dues** ticked on the product in `/admin/products`, a non-member sees **Membership required** instead. |
| 5 | Complete the LSC payment | `Entitlement` `league_access` for `lone-star-cup` valid to the open `Season.endAt` (Dec 31 if none); `LEAGUE_REGISTERED` notification mentioning the Discord role; page shows **You're entered**; the driver shows as **Paid** in `/admin/league-entries`. |
| 6 | Replay the completed event: `stripe events resend <evt_…>` | No new rows. Handler returns early on `status === "succeeded"`. |
| 7 | Full refund of step 2's charge: `stripe refunds create --payment-intent <pi_…>` (or the dashboard) | `Payment` `refunded`; entitlement `validTo` = now; the dues `UserMembership` is expired (created) or restored to its previous `validTo` (extended); badge gone on next load; `AuditLog` lists the revoked entitlement id. |
| 8 | Start a checkout, don't pay, then `stripe checkout sessions expire <cs_…>` | `Payment` `failed`; `AuditLog` `PAYMENT_EXPIRED`. |
| 9 | Paid event registration (existing flow) | Unchanged: `REGISTERED`, `REGISTRATION_CONFIRMED`, seat counted. |
| 10 | Officer → `/admin/payments` | Rows from steps 2, 5, 7, 8 with the right status and a working Stripe link. |
| 11 | Officer → `/admin/league-entries` → edit a driver who hasn't paid → tick **Also enter them now** | Status **Entered (manual)** with the note; the driver's `/lone-star-cup` shows **You're entered**. Ending it (✕) sets the entitlement's `validTo` to now. |

Anything that fails here is a blocker for the merge, not a follow-up.

## Steps 1–8 without a browser

`apps/platform/scripts/payments-smoke.ts` drives the service layer directly: real Stripe **test-mode** Checkout Sessions, then signed `checkout.session.completed` / `charge.refunded` / `checkout.session.expired` events fed into `handleStripeWebhook()`, asserting every row the checklist expects. It refuses to run against a live key.

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres STRIPE_TEST_SECRET_KEY=sk_test_… pnpm --filter @lsr/platform exec tsx scripts/payments-smoke.ts
```

Run it first; it takes about ten seconds. Steps 9–10 and the page states still need the browser.

## Webhook edge cases, offline

`apps/platform/scripts/payments-webhook-check.ts` replays the cases from the #95 review against the local database: duplicate and concurrent deliveries, redelivery after a refund, unpaid and delayed payments, refunds after a later membership change, never shortening a membership, and sessions we didn't create. No Stripe key or network needed.

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/payments-webhook-check.ts
```
