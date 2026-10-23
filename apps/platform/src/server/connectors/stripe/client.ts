import Stripe from "stripe"
import { fakesEnabledFor, fakesOrigin, serviceFetch } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * Jack's read-only Stripe client (design §12.3). It uses a restricted key (STRIPE_READONLY_KEY, rk_…)
 * with Read on balance, payouts, charges and disputes and every write off, and it offers only the list
 * and retrieve calls the sync needs: the SDK client never leaves this file, so no caller can create a
 * refund, a payout or a charge through it. The checkout key (STRIPE_SECRET_KEY, src/lib/stripe.ts) is
 * never used here.
 */

/** The longest one call may take (the SDK's default is 80 s, too long inside a job) */
export const STRIPE_TIMEOUT_MS = 20_000

/** Most rows one list call returns across its pages */
export const STRIPE_LIST_MAX = 2_000

/** Why this key can't be Jack's Stripe key, or null when it can */
export function readKeyProblem(key: string | undefined, env: ConnectorEnv = process.env): string | null {
  if (!key?.trim()) return "STRIPE_READONLY_KEY isn't set"
  if (!key.startsWith("rk_")) return "STRIPE_READONLY_KEY must be a restricted key (rk_…), never a secret key"
  if (key.startsWith("rk_live_") && env.VERCEL_ENV !== "production") return "A live key (rk_live_…) is only used in production; use a test key (rk_test_…) here"
  return null
}

/** "live" or "test", from the key's prefix (never shows the key) */
export function keyMode(key: string): "live" | "test" {
  return key.startsWith("rk_live_") ? "live" : "test"
}

/** A Stripe call that failed, with the status and Stripe's error type; never the key */
export class StripeReadError extends Error {
  constructor(
    readonly status: number | null,
    readonly type: string,
    message: string,
  ) {
    super(message)
    this.name = "StripeReadError"
  }
}

const HINTS: Record<number, string> = {
  401: "the key is wrong, expired or was rotated",
  403: "the key is missing a Read permission (docs/jack-2/tracks/sources-a.md lists them)",
  429: "Stripe is rate limiting; the next run tries again",
}

/** A Stripe SDK error as one line: what failed and why, with a hint for the usual causes */
export function stripeErrorText(error: unknown, what: string): StripeReadError {
  if (error instanceof StripeReadError) return error
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode ?? null
    const hint = status ? HINTS[status] : undefined
    return new StripeReadError(status, error.type, `Stripe ${status ?? "request"} on ${what} (${error.type}${error.code ? `, ${error.code}` : ""}): ${error.message}${hint ? `. Likely ${hint}` : ""}`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new StripeReadError(null, "connection_error", `Stripe call failed on ${what}: ${message}`)
}

export type StripeReadOptions = {
  /** Aborts every call this client makes (a job's deadline, a smoke test's timeout) */
  signal?: AbortSignal
  /** The SDK retries 409s, 5xx and lock timeouts this many times, with backoff (default 2) */
  maxNetworkRetries?: number
  env?: ConnectorEnv
}

/** Most objects Stripe returns say whether they're live (refunds and balance transactions don't); a test key's data must never land in production's tables, or the other way round */
function checkMode(items: object[], env: ConnectorEnv) {
  const live = env.VERCEL_ENV === "production"
  const wrong = items.find((item): item is { livemode: boolean } => "livemode" in item && typeof item.livemode === "boolean" && item.livemode !== live)
  if (wrong) throw new StripeReadError(null, "mode_mismatch", `Stripe returned ${wrong.livemode ? "live" : "test"}-mode data ${live ? "in production" : "outside production"}; check STRIPE_READONLY_KEY`)
}

/** A fetch that also stops when `signal` aborts */
function withSignal(base: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (!signal) return base
  return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
}

export type StripeReadClient = ReturnType<typeof stripeReadClient>

export function stripeReadClient(key: string, options: StripeReadOptions = {}) {
  const env = options.env ?? process.env
  const problem = readKeyProblem(key, env)
  if (problem) throw new StripeReadError(null, "configuration", problem)

  // The SDK takes a host but no base path: with fakes on, it talks to the fakes server and serviceFetch() adds the /stripe mount (groundwork.md, "SDK notes")
  const fakes = fakesEnabledFor("stripe", env) ? new URL(fakesOrigin(env)) : null
  const stripe = new Stripe(key, {
    ...(fakes && { host: fakes.hostname, port: Number(fakes.port || 80), protocol: "http" as const }),
    httpClient: Stripe.createFetchHttpClient(withSignal(serviceFetch("stripe", env), options.signal)),
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: options.maxNetworkRetries ?? 2,
    telemetry: false,
  })

  async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted()
    try {
      return await run()
    } catch (error) {
      // A deadline or a smoke test's timeout: pass the abort on as it is, so callers can tell it apart
      if (options.signal?.aborted) throw options.signal.reason
      throw stripeErrorText(error, what)
    }
  }

  async function list<T extends object>(what: string, page: () => Stripe.ApiListPromise<T>): Promise<T[]> {
    const items = await call(what, () => page().autoPagingToArray({ limit: STRIPE_LIST_MAX }))
    checkMode(items, env)
    return items
  }

  const since = (date: Date) => ({ gte: Math.floor(date.getTime() / 1000) })

  return {
    mode: keyMode(key),
    async balance(): Promise<Stripe.Balance> {
      const balance = await call("the balance", () => stripe.balance.retrieve())
      checkMode([balance], env)
      return balance
    },
    /** Payouts created since `createdGte`, newest first */
    payouts: (createdGte: Date) => list("payouts", () => stripe.payouts.list({ created: since(createdGte), limit: 100 })),
    /** The balance transactions an automatic payout paid out, the payout's own included (only once its reconciliation_status is "completed") */
    payoutTransactions: (payoutId: string) => list(`payout ${payoutId}'s transactions`, () => stripe.balanceTransactions.list({ payout: payoutId, limit: 100 })),
    /** Every balance transaction created since `createdGte`: each charge's fee and net */
    balanceTransactions: (createdGte: Date) => list("balance transactions", () => stripe.balanceTransactions.list({ created: since(createdGte), limit: 100 })),
    charges: (createdGte: Date) => list("charges", () => stripe.charges.list({ created: since(createdGte), limit: 100 })),
    refunds: (createdGte: Date) => list("refunds", () => stripe.refunds.list({ created: since(createdGte), limit: 100 })),
    disputes: (createdGte: Date) => list("disputes", () => stripe.disputes.list({ created: since(createdGte), limit: 100 })),
  }
}
