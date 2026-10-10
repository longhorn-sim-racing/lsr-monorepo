# Payments

How the site takes money through Stripe, what a payment turns into, and what officers can do by hand. For testing, see [payments-test-checklist.md](./payments-test-checklist.md).

Code paths below are relative to `apps/platform/`.

## What we sell

| Purchase | Status (Fall 2026) | What it grants |
|---|---|---|
| **Lone Star Cup entry** (`LEAGUE_FEE` product) | On sale: $10, or $5 for returning drivers | A `league_access` entitlement until the open season ends |
| **Annual dues** (`ANNUAL_DUES` product) | Off: no dues this semester | An `lsr_member` entitlement until Jul 31 |
| **Paid event registration** (`Event.registrationFeeCents`) | Available on any event with a fee | A seat (`EventRegistration`), or a waitlist spot if the event filled up during checkout |

Products are rows in the `Product` table (seeded by `prisma/seed.cjs`), not Stripe Products. Checkout sends the price inline, so changing a price is an edit in `/admin/products`, not a Stripe dashboard change.

## How a purchase works

Lone Star Cup entry, end to end:

1. The driver fills out the entry form at `/lone-star-cup/enter`, which saves a `LeagueApplication` for the open season.
2. The page calls `POST /api/checkout` with `{ product: "LEAGUE_FEE", league: "lone-star-cup" }`.
3. `createProductCheckoutSession()` checks the purchase is allowed (below), expires any older unpaid checkout for the same product, works out the price, creates a `Payment` row with status `pending`, and opens a Stripe Checkout Session whose metadata carries the `paymentId`.
4. The driver pays on Stripe's page and comes back to `/lone-star-cup?payment=success`.
5. Stripe calls `/api/stripe/webhook`. `handleStripeWebhook()` marks the `Payment` `succeeded`, creates the entitlement in the same transaction, writes an audit log entry, and sends an in-app and email notification.
6. The driver shows as **Paid** in `/admin/league-entries`, where Competition gives them the Discord role that unlocks the car and track downloads. That last step is manual for now (#59).

Dues follow the same path from the `/account` page. Paid event registration is older and uses `createEventCheckoutSession()` and `/api/events/[slug]/checkout`, but settles through the same webhook.

### Checks before checkout

`createProductCheckoutSession()` refuses, with a message the page shows, when:

- the product is missing or inactive, or costs nothing;
- the user already has an active entitlement of that kind ("already entered", "membership already active");
- the league has no open season, or the user hasn't filled out the entry form for it;
- the product requires dues (`requiresMembership`) and the user has no membership.

### What a payment grants

| Product | Entitlement | Ends |
|---|---|---|
| `LEAGUE_FEE` | `league_access` for the product's league, `meta.seasonSlug` = the open season | The open season's `endAt` (Dec 31 if the season has none) |
| `ANNUAL_DUES` | `lsr_member`, plus a `UserMembership` row on the `LSR_MEMBER` tier (the admin user list reads that) | Jul 31, the end of the membership year |

The "open season" is the league's season that hasn't ended yet with the earliest end date (`getOpenLeagueSeason()`). So a new season only takes over entry once the current one's `endAt` passes: creating next season early doesn't move entry, and between seasons entry is closed. `scripts/setup-lsc-season-3.ts` is the example of standing one up.

## Prices

The price lives on the product: `amountCents`, plus optional keys in `metadata`, all editable in `/admin/products`:

- `returningAmountCents` and `returningSeasonSlugs`: drivers who appear in the standings of any listed season pay the lower price. Adding a season to the list is a data change, not a deploy.
- `requiresMembership`: only drivers with paid dues can enter. Off for Lone Star Cup, and it can't be switched on while no dues product is on sale.

The price is always worked out on the server at checkout; the page only displays it.

## Webhook

Endpoint: `/api/stripe/webhook`, verified with `STRIPE_WEBHOOK_SECRET`. The production endpoint in the Stripe dashboard sends these five events:

| Event | What happens |
|---|---|
| `checkout.session.completed` | If `payment_status` is `paid`: grant. Otherwise wait for one of the async events. |
| `checkout.session.async_payment_succeeded` | Grant (delayed payment methods such as bank debits). |
| `checkout.session.async_payment_failed` | Mark the `Payment` `failed`. |
| `checkout.session.expired` | Mark the `Payment` `failed`. |
| `charge.refunded` | Mark the `Payment` `refunded`, even for a partial refund. For dues and league entry, a **full** refund also ends the entitlement and undoes its dues membership change, unless that row has changed since; a partial refund leaves the entitlement in place. Refunding a paid event registration leaves the seat taken: cancel it by hand. |

Rules the handler keeps:

- **Each payment grants once.** The `pending` → `succeeded` claim is atomic and happens in the same transaction as the grant, so redelivered or concurrent events grant nothing extra.
- **Sessions we didn't create are ignored**, not rejected (no `paymentId` in metadata, or an unknown one: Payment Links, `stripe trigger`, another environment). Stripe would otherwise retry them for days.
- **Donations live only in Stripe.** They go through a Stripe Payment Link (`DONATE_URL` in `src/lib/sponsors.ts`, used by /sponsors and the sponsor packet), so the app keeps no record of them and they don't appear in `/admin/payments`. Look them up and refund them in the Stripe dashboard (filter by metadata `purpose: donation`). Never add a `paymentId` to the link's metadata: Stripe copies it onto every session, and the webhook would then treat donations as app payments.
- **Duplicates are flagged, never refunded automatically.** If someone pays for something they already have for at least as long (say an officer entered them while their checkout tab was open), the payment is kept, nothing more is granted, `metadata.duplicateOfEntitlementId` is set, and a `PAYMENT_DUPLICATE` audit entry is written. `/admin/payments` tags it **Duplicate — refund** for an officer to refund in Stripe.
- **Refunds only happen in the Stripe dashboard.** No code moves money.

## Manual entries

In `/admin/league-entries`, an officer can enter a driver without a Stripe payment (paid another way, comped, or backfilled): use the ticket button on the driver's row, or edit the driver and tick **Also enter them now**. Both only appear while viewing the open season. That creates a `league_access` entitlement with `meta.source = "manual"`, the officer's id and an optional note, and it expires any unpaid checkout the driver still has open.

An officer can end a manual entry there, but not a paid one: paid entries end by refunding them in Stripe. Ending a manual entry is also refused if the driver paid on top of it, since that would leave a paying driver with no entry.

## Officer tools

| Page | For |
|---|---|
| `/admin/payments` | Every payment, filterable by status and kind, with links to Stripe. Tags **Duplicate — refund** and **Paid, no entry** (a flagged duplicate whose original entry has since ended). |
| `/admin/products` | Name, price, on/off, returning-driver price and seasons, the dues requirement. Products are seeded; this page edits them, it doesn't create them. |
| `/admin/league-entries` | Entry forms and entries per season, manual entries, CSV export. |

The audit log records grants, refunds, duplicates, webhook failures and expiries, and officer changes: `PAYMENT_SUCCEEDED`, `PAYMENT_REFUNDED`, `PAYMENT_FAILED`, `PAYMENT_EXPIRED`, `PAYMENT_DUPLICATE`, `LEAGUE_ENTRY_GRANTED`, `LEAGUE_ENTRY_REVOKED`, `LEAGUE_APPLICATION_CREATED`, `LEAGUE_APPLICATION_UPDATED` and `PRODUCT_UPDATED`. Two paths mark a payment `failed` without an audit entry: Stripe refusing to create the session, and finding an already-expired session while expiring old checkouts.

## Environment

| Variable | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` locally and on previews; the live key only in Vercel production. |
| `STRIPE_WEBHOOK_SECRET` | Locally, the `whsec_…` that `stripe listen --forward-to localhost:3000/api/stripe/webhook` prints. In production, the endpoint's signing secret. |
| `NEXT_PUBLIC_SITE_URL` | Where Stripe sends people back to. Falls back to the Vercel URL, then `localhost:3000`. |

Production credentials live only in Vercel, never in local env files.

## Testing

- [payments-test-checklist.md](./payments-test-checklist.md): the manual run before merging payment changes.
- `scripts/payments-smoke.ts`: steps 1–8 of that checklist against Stripe test mode, no browser. Refuses a live key or a non-local database.
- `scripts/payments-webhook-check.ts`: webhook edge cases against the local database, no Stripe calls.

## Code map

| File | What's in it |
|---|---|
| `src/server/services/payment.service.ts` | Checkout creation (products and events) and the webhook handler |
| `src/server/services/product-pricing.ts` | Returning-driver pricing and the dues requirement |
| `src/server/services/checkout-sessions.ts` | Expiring a user's unpaid checkouts |
| `src/server/services/league-entry.service.ts` | Open season, entry forms, manual entries, the entrant list |
| `src/server/services/product.service.ts` | `/admin/products` edits and their checks |
| `src/app/api/checkout/route.ts` | `POST /api/checkout` |
| `src/app/api/stripe/webhook/route.ts` | The webhook endpoint |
| `src/components/product-checkout-button.tsx` | The buy button, and `startProductCheckout()` used by the entry form |

## Known gaps

- Discord roles are handed out by hand after payment (#59 would automate it).
- Paid event checkouts don't expire an older unpaid tab the way product checkouts do, and paying a second tab isn't flagged: the registration moves to the newer payment and the first one is left `succeeded` with no seat and no tag in `/admin/payments`.
- Refunding a paid event registration doesn't free the seat.
- If an officer enters a driver by hand at the same instant that driver's payment lands, both can go through without a duplicate flag. Rare, and hard to spot: the driver shows once, as **Paid**, and the extra manual entry only appears in the audit log (`LEAGUE_ENTRY_GRANTED` next to `PAYMENT_SUCCEEDED`).
