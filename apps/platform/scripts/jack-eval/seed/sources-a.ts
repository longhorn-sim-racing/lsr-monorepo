import type { EvalSeeder } from "./types";

/**
 * Fills the eval copy with the sources-a track's fake data before a run (pnpm jack:eval:prepare). Must
 * be safe to run again. Stripe and site traffic come from their syncs against the fakes server (start
 * it with `pnpm jack:fakes`); email delivery comes through the webhook's own parsing and storing, with
 * made-up recipients at resend.dev (never a member's address). Modules load inside run(), after
 * prepare has pointed the database at the eval copy.
 */
export const SEEDERS: EvalSeeder[] = [
  {
    name: "stripe: balance, payouts, charges, refunds and disputes",
    run: async () => {
      const { stripeReadClient } = await import("../../../src/server/connectors/stripe/client");
      const { STRIPE_FAKE_KEY } = await import("../../../src/server/connectors/stripe/fake/handlers");
      const { syncStripe } = await import("../../../src/server/connectors/stripe/sync");
      const { recordConnectorSync } = await import("../../../src/server/connectors/state");
      const result = await syncStripe(stripeReadClient(STRIPE_FAKE_KEY, { maxNetworkRetries: 0 }), { backfill: true });
      if (result.errors.length) throw new Error(`${result.errors.join("; ")} (is \`pnpm jack:fakes\` running?)`);
      await recordConnectorSync("stripe");
      return result.summary;
    },
  },
  {
    name: "resend: delivery events",
    run: async ({ now }) => {
      const { emailEventRow, recordEmailEvent } = await import("../../../src/server/connectors/resend/webhook");
      const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
      // Each fake email: its recipient and the events Resend would send, hours ago
      const emails: { id: string; to: string; events: [string, number, Record<string, unknown>?][] }[] = [
        { id: "eval-email-delivered-1", to: "delivered+eval1@resend.dev", events: [["email.sent", 30], ["email.delivered", 29.9]] },
        { id: "eval-email-delivered-2", to: "delivered+eval2@resend.dev", events: [["email.sent", 30], ["email.delivered", 29.9]] },
        { id: "eval-email-bounced-1", to: "bounced+eval1@resend.dev", events: [["email.sent", 30], ["email.bounced", 29.9, { bounce: { type: "Permanent", subType: "General", message: "The recipient's email address does not exist." } }]] },
        { id: "eval-email-bounced-2", to: "bounced+eval2@resend.dev", events: [["email.sent", 50], ["email.delivery_delayed", 49], ["email.bounced", 40, { bounce: { type: "Transient", subType: "MailboxFull", message: "Mailbox full." } }]] },
        { id: "eval-email-complained", to: "complained+eval@resend.dev", events: [["email.sent", 70], ["email.delivered", 69.9], ["email.complained", 60]] },
      ];
      let stored = 0;
      for (const email of emails) {
        for (const [i, [type, hours, extra]] of email.events.entries()) {
          const payload = { type, created_at: ago(hours), data: { email_id: email.id, created_at: ago(email.events[0][1]), to: [email.to], subject: "Eval: a fake club email", ...extra } };
          const row = emailEventRow(payload, `msg_eval_${email.id}_${i}`);
          if (row && (await recordEmailEvent(row))) stored++;
        }
      }
      return `${emails.length} fake emails, ${stored} new events`;
    },
  },
  {
    name: "site traffic: a month of daily snapshots",
    run: async () => {
      const { siteTrafficClient } = await import("../../../src/server/connectors/site-traffic/client");
      const { SITE_TRAFFIC_FAKE_PROJECT, SITE_TRAFFIC_FAKE_TOKEN } = await import("../../../src/server/connectors/site-traffic/fake/handlers");
      const { snapshotSiteTraffic } = await import("../../../src/server/connectors/site-traffic/snapshot");
      const { recordConnectorSync } = await import("../../../src/server/connectors/state");
      const result = await snapshotSiteTraffic(siteTrafficClient(SITE_TRAFFIC_FAKE_TOKEN, SITE_TRAFFIC_FAKE_PROJECT));
      await recordConnectorSync("site-traffic");
      return result.summary;
    },
  },
];
