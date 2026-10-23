import { prisma } from "@/server/db"
import type { StripeReadClient } from "./client"
import { applyChargeTransactions, saveBalance, saveCharge, saveDispute, savePayout, saveRefund } from "./store"

/**
 * The daily Stripe sync (design §12.3): the balance, payouts with the charges each one paid out,
 * charges with their fee and net, refunds and disputes, into the club's tables. Read only, and cheap:
 * Stripe allows an average of 500 reads per transaction a month (at least 10,000), and a run makes
 * about ten calls plus one per newly paid payout. Every write is an upsert, so a rerun changes nothing.
 */

const DAY_MS = 86_400_000

/** How far back each run looks: payouts settle within days, refunds and disputes change for weeks */
export const SYNC_LOOKBACK_DAYS = 120
/** How far back the first run looks */
export const BACKFILL_DAYS = 400
/** Most payouts whose transactions one run lists (each is a call) */
export const MAX_PAYOUTS_LINKED = 25

export type StripeSyncResult = {
  summary: string
  counts: Record<string, number>
  /** It stopped at the deadline or the payout cap; the next run picks up the rest */
  more: boolean
  /** Steps that failed, each as one line (the rest still ran) */
  errors: string[]
}

export async function syncStripe(client: StripeReadClient, options: { now?: Date; backfill?: boolean; signal?: AbortSignal } = {}): Promise<StripeSyncResult> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - (options.backfill ? BACKFILL_DAYS : SYNC_LOOKBACK_DAYS) * DAY_MS)
  const counts: Record<string, number> = { payouts: 0, charges: 0, fees: 0, linkedCharges: 0, refunds: 0, disputes: 0 }
  const errors: string[] = []
  let more = false

  /** Runs one step; a failure is noted and the next step still runs. Returns false once the deadline passed */
  const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    if (options.signal?.aborted) return false
    try {
      await run()
    } catch (error) {
      if (options.signal?.aborted) return false
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return !options.signal?.aborted
  }

  // Each write is stamped with when its data was asked for, so a webhook event that lands meanwhile wins
  let payoutIds: { id: string; linkable: boolean }[] = []
  const steps: [string, () => Promise<void>][] = [
    [
      "balance",
      async () => {
        await saveBalance(await client.balance(), now)
      },
    ],
    [
      "payouts",
      async () => {
        const at = new Date()
        const payouts = await client.payouts(since)
        for (const payout of payouts) if (await savePayout(payout, at)) counts.payouts += 1
        payoutIds = payouts.map((p) => ({ id: p.id, linkable: p.automatic && p.reconciliation_status === "completed" }))
      },
    ],
    [
      "charges",
      async () => {
        const at = new Date()
        for (const charge of await client.charges(since)) {
          await saveCharge(charge, at)
          counts.charges += 1
        }
      },
    ],
    [
      "fees",
      async () => {
        counts.fees = await applyChargeTransactions(await client.balanceTransactions(since))
      },
    ],
    [
      "payout contents",
      async () => {
        // Only paid automatic payouts can be broken down, and once linked they never change
        const linkable = payoutIds.filter((p) => p.linkable).map((p) => p.id)
        if (!linkable.length) return
        const linked = await prisma.stripeCharge.findMany({ where: { payoutId: { in: linkable } }, distinct: ["payoutId"], select: { payoutId: true } })
        const done = new Set(linked.map((row) => row.payoutId))
        const todo = linkable.filter((id) => !done.has(id))
        if (todo.length > MAX_PAYOUTS_LINKED) more = true
        for (const id of todo.slice(0, MAX_PAYOUTS_LINKED)) {
          if (options.signal?.aborted) return
          counts.linkedCharges += await applyChargeTransactions(await client.payoutTransactions(id), id)
        }
      },
    ],
    [
      "refunds",
      async () => {
        const at = new Date()
        for (const refund of await client.refunds(since)) {
          await saveRefund(refund, at)
          counts.refunds += 1
        }
      },
    ],
    [
      "disputes",
      async () => {
        const at = new Date()
        for (const dispute of await client.disputes(since)) {
          await saveDispute(dispute, at)
          counts.disputes += 1
        }
      },
    ],
  ]

  for (const [name, run] of steps) {
    if (!(await step(name, run))) {
      more = true
      break
    }
  }

  const parts = [
    `${counts.payouts} payouts`,
    `${counts.charges} charges (${counts.fees} with fees${counts.linkedCharges ? `, ${counts.linkedCharges} matched to payouts` : ""})`,
    `${counts.refunds} refunds`,
    `${counts.disputes} disputes`,
  ]
  const summary = `${options.backfill ? `First run, back ${BACKFILL_DAYS} days` : `Last ${SYNC_LOOKBACK_DAYS} days`}: the balance, ${parts.join(", ")}${more ? ". Stopped early; the next run continues" : ""}`
  return { summary, counts, more, errors }
}
