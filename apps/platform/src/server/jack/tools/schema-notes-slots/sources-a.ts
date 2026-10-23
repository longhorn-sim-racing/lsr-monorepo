import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the sources-a track's tables: Stripe, email delivery and site traffic */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Stripe, email delivery and site traffic (synced copies; stripe_overview, email_delivery and site_traffic read them with the club's rules)
- "StripeBalanceDaily", "StripePayout", "StripeCharge", "StripeRefund", "StripeDispute": Stripe's own records, amounts in cents, synced once a day (payouts and disputes also by Stripe's webhook). StripeCharge.paymentIntentId = "Payment".providerRef (pi_…) for site checkouts; purpose 'donation' marks the donation link, which has no Payment row. StripeCharge.payoutId is set once its payout's contents are read (paid automatic payouts only). A payout's arrivalDate is midnight UTC: read it as a UTC date. No card, billing or customer details are stored.
- "EmailEvent": one Resend delivery event for one recipient (type email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed, email.suppressed, email.opened, email.clicked). resendId = "Notification".emailMessageId or "ApplicationEmail".resendMessageId. An email's status comes from all its events, strongest first: complained, bounced, failed, suppressed, clicked, opened, delivered, delivery_delayed, sent (events arrive in any order). Kept 12 months.
- "SiteTrafficDaily": Vercel Web Analytics per UTC day (not the Chicago date), public pages only: dimension 'total' (key 'all'), 'path', 'referrer' ('(direct)' when none), 'country', 'device', the top 100 groups a day each (the rest in 'Others'). visitors are counted per day, so summing days counts a returning visitor again.`,
  tableNotes: {
    StripeBalanceDaily: "The Stripe balance once a day (date = Chicago date), cents: available can be paid out, pending hasn't settled.",
    StripePayout: "A payout to the club's bank: status pending, in_transit, paid, failed (failureCode) or canceled; arrivalDate is a UTC date.",
    StripeCharge: "A Stripe charge: paymentIntentId joins Payment.providerRef; fee and net in cents; payoutId once paid out; purpose 'donation' for donations.",
    StripeRefund: "A refund (read only; refunds happen in the Stripe dashboard). status can be failed.",
    StripeDispute: "A chargeback or inquiry; evidenceDueBy is when a response is due (status needs_response or warning_needs_response).",
    EmailEvent: "One Resend delivery event per recipient; join resendId to Notification.emailMessageId or ApplicationEmail.resendMessageId.",
    SiteTrafficDaily: "Site traffic per UTC day by dimension (total, path, referrer, country, device); visitors are per day.",
  },
}
