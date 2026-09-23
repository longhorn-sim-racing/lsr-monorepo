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
| 4 | New user (no dues) → `/lone-star-cup` → **Enter** | `400` "An active LSR membership is required…" (gate pending #82). |
| 5 | Member → `/lone-star-cup` → **Enter** → pay | `Entitlement` `league_access` for `lone-star-cup` valid to the current `Season.endAt` (Dec 31 if none); `LEAGUE_REGISTERED` notification; page shows **You're entered**. |
| 6 | Replay the completed event: `stripe events resend <evt_…>` | No new rows. Handler returns early on `status === "succeeded"`. |
| 7 | Full refund of step 2's charge: `stripe refunds create --payment-intent <pi_…>` (or the dashboard) | `Payment` `refunded`; entitlement `validTo` = now; the dues `UserMembership` is expired (created) or restored to its previous `validTo` (extended); badge gone on next load; `AuditLog` lists the revoked entitlement id. |
| 8 | Start a checkout, don't pay, then `stripe checkout sessions expire <cs_…>` | `Payment` `failed`; `AuditLog` `PAYMENT_EXPIRED`. |
| 9 | Paid event registration (existing flow) | Unchanged: `REGISTERED`, `REGISTRATION_CONFIRMED`, seat counted. |
| 10 | Officer → `/admin/payments` | Rows from steps 2, 5, 7, 8 with the right status and a working Stripe link. |

Anything that fails here is a blocker for the merge, not a follow-up.
