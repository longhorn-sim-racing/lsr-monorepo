import { prisma } from "@/server/db"
import { recordConnectorError, recordConnectorSync, readConnectorState } from "@/server/connectors/state"
import { siteTrafficConnector } from "@/server/connectors/site-traffic/connector"
import { snapshotSiteTraffic } from "@/server/connectors/site-traffic/snapshot"
import { stripeConnector } from "@/server/connectors/stripe/connector"
import { syncStripe } from "@/server/connectors/stripe/sync"
import type { JobKind } from "../types"

/**
 * Scheduled job kinds from the sources-a track (design §6, §12.3-§12.5): the Stripe sync, the site
 * traffic snapshot, and pruning old email delivery events. Like every job they ship switched off; the
 * syncs also skip while their connector is off or not set up.
 */

const DAY_MS = 86_400_000

/** Email delivery events are kept a year (the privacy page says delivery logs are kept up to a year) */
export const EMAIL_EVENT_RETENTION_DAYS = 365

/** Stripe's sync cursor: whether the first run's long look back is done. Never a key */
type StripeCursor = { backfilledAt?: string }

export const JOBS: JobKind[] = [
  {
    kind: "stripe.sync",
    label: "Stripe sync",
    description:
      "Copies the Stripe balance, payouts (and the charges each one paid out), charges with their fees, refunds and disputes into the club's tables, read only, for the Payments page and Jack. Looks back 120 days (400 on its first run). Skips while the Stripe connector is off.",
    defaultSchedule: "0 5 * * *",
    budgetMs: 120_000,
    async run({ signal, log }) {
      try {
        // Throws for a key that isn't a restricted one (or a live key outside production)
        const connection = await stripeConnector.client()
        if (!connection) return { summary: "Stripe isn't connected (switched off, or STRIPE_READONLY_KEY isn't set)", status: "skipped" }
        const cursor = ((await readConnectorState("stripe"))?.cursor ?? {}) as StripeCursor
        const result = await syncStripe(connection.open({ signal }), { backfill: !cursor.backfilledAt, signal })
        if (result.errors.length) throw new Error(`${result.summary}. Failed: ${result.errors.join("; ")}`)
        // The long first look back counts as done only once it finished in one run
        const keepCursor = Boolean(cursor.backfilledAt) || result.more
        await recordConnectorSync("stripe", keepCursor ? {} : { cursor: { backfilledAt: new Date().toISOString() } satisfies StripeCursor })
        if (result.more) log("Stopped before the end; the next run continues.")
        return { summary: result.summary, counts: result.counts }
      } catch (error) {
        await recordConnectorError("stripe", error)
        throw error
      }
    },
  },
  {
    kind: "site-traffic.snapshot",
    label: "Site traffic snapshot",
    description:
      "Stores each complete day of site traffic from Vercel Web Analytics (page views, visitors, and the top pages, referrers, countries and devices), because Vercel keeps only a month. Fills any missing day in that month, so the first run backfills it. Days are UTC. Skips while the site traffic connector is off.",
    defaultSchedule: "30 3 * * *",
    budgetMs: 120_000,
    async run({ signal, log }) {
      try {
        const client = await siteTrafficConnector.client()
        if (!client) return { summary: "Site traffic isn't connected (switched off, or the Vercel token or project id isn't set)", status: "skipped" }
        const result = await snapshotSiteTraffic(client, { signal, log })
        await recordConnectorSync("site-traffic")
        return { summary: result.summary, counts: result.counts }
      } catch (error) {
        await recordConnectorError("site-traffic", error)
        throw error
      }
    },
  },
  {
    kind: "email-events.prune",
    label: "Prune email delivery events",
    description: `Deletes Resend delivery events (who an email went to and whether it arrived) older than ${EMAIL_EVENT_RETENTION_DAYS} days, as the privacy page promises.`,
    defaultSchedule: "40 4 * * *",
    budgetMs: 60_000,
    async run() {
      const { count } = await prisma.emailEvent.deleteMany({ where: { occurredAt: { lt: new Date(Date.now() - EMAIL_EVENT_RETENTION_DAYS * DAY_MS) } } })
      return { summary: count ? `Deleted ${count} delivery events older than ${EMAIL_EVENT_RETENTION_DAYS} days` : `Nothing older than ${EMAIL_EVENT_RETENTION_DAYS} days`, counts: { deleted: count } }
    },
  },
]
