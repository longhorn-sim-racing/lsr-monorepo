import type { PromptSlot } from "./types"

/** Outside sources A (Stripe, Resend, site traffic): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Stripe, email delivery and site traffic
- stripe_overview (the Stripe balance, payouts and what each paid out, charges with fees, refunds, disputes), email_delivery (whether club emails arrived, and the addresses that bounce) and site_traffic (page views and visitors by day, page, referrer, country and device) load through tool search. They read a daily sync or Resend's reports, and each says how fresh its data is and whether it's connected.
- Stripe is read only for you: never offer to refund, pay out or answer a dispute; point officers to the Stripe dashboard. When a dispute needs a response, give its due date.
- Look up one person's email only when an officer named that person or address. "Delivered" means their mail server took it, not that they read it.
- Site traffic days are UTC and leave out admin pages. Vercel counts a visitor once a day, so give a range's visitors as a daily average, never as a number of people.`,
  pages: [
    "Payments also shows the Stripe balance, payouts, refunds and disputes (read only: refunds and dispute responses happen in the Stripe dashboard).",
    "Notifications → Delivery: which emails arrived and the addresses that bounce. Recruiting emails also lists recruiting mail that didn't arrive.",
    "Overview: site traffic for the latest week (page views, visitors a day, top pages).",
  ],
}
