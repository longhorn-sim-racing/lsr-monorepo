import { prisma } from "@/server/db"
import { defineConnector } from "../define"
import { keyMode, readKeyProblem, stripeReadClient, type StripeReadClient } from "./client"

/** What client() hands out: opens a read client whose calls stop when `signal` aborts (the SDK takes no signal per call) */
export type StripeConnection = { mode: "live" | "test"; open(options?: { signal?: AbortSignal }): StripeReadClient }

const DAY_MS = 86_400_000

/**
 * Stripe, read only (design §12.3): the daily sync job, Jack's stripe_overview and the Stripe panel on
 * Payments. The webhook's payout and dispute events are stored whether or not this is switched on:
 * they're Stripe's own signed messages about the club's account, and the sync fills in the rest.
 */
export const stripeConnector = defineConnector<StripeConnection>({
  id: "stripe",
  label: "Stripe (read only)",
  requiredEnv: ["STRIPE_READONLY_KEY"],
  createClient: (env) => {
    const key = env.STRIPE_READONLY_KEY!
    const problem = readKeyProblem(key, env)
    if (problem) throw new Error(problem)
    return { mode: keyMode(key), open: ({ signal } = {}) => stripeReadClient(key, { signal, env }) }
  },
  // Works while switched off: it builds its own client. Reads only; no amounts go into the summary (it's kept in the audit log)
  async smoke({ signal } = {}) {
    const key = process.env.STRIPE_READONLY_KEY ?? ""
    const client = stripeReadClient(key, { signal, maxNetworkRetries: 0 })
    const since = new Date(Date.now() - 30 * DAY_MS)
    await client.balance()
    const [payouts, charges, disputes] = await Promise.all([client.payouts(since), client.charges(since), client.disputes(since)])
    return { ok: true, summary: `Read the balance, ${payouts.length} payouts, ${charges.length} charges and ${disputes.length} disputes from the last 30 days (${client.mode} mode)` }
  },
  async details() {
    const key = process.env.STRIPE_READONLY_KEY
    const lines: { label: string; value: string }[] = []
    if (key) {
      const problem = readKeyProblem(key)
      lines.push({ label: "Key", value: problem ?? `Restricted key, ${keyMode(key)} mode` })
    }
    const latest = await prisma.stripeBalanceDaily.findFirst({ orderBy: { date: "desc" }, select: { date: true } })
    if (latest) lines.push({ label: "Latest balance", value: latest.date.toISOString().slice(0, 10) })
    return lines
  },
})
