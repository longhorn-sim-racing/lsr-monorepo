/**
 * The Stripe fake's data (research/stripe.md §7): a small club account in test mode, relative to the
 * moment the fake starts. Consistent the way Stripe is: each paid automatic payout's transactions add up
 * to its amount, and the balance is what the transactions leave available or pending. No real people:
 * billing names and emails are made up.
 */

const DAY = 86_400

export type FakeCharge = {
  id: string
  object: "charge"
  amount: number
  amount_captured: number
  amount_refunded: number
  currency: "usd"
  created: number
  status: "succeeded" | "pending" | "failed"
  paid: boolean
  refunded: boolean
  disputed: boolean
  payment_intent: string | null
  balance_transaction: string | null
  description: string | null
  metadata: Record<string, string>
  billing_details: { name: string | null; email: string | null; address: null; phone: null }
  receipt_email: string | null
  payment_method_details: { type: "card"; card: { brand: string; last4: string } }
  livemode: false
}

export type FakeBalanceTransaction = {
  id: string
  object: "balance_transaction"
  type: string
  reporting_category: string
  amount: number
  fee: number
  net: number
  currency: "usd"
  status: "available" | "pending"
  created: number
  available_on: number
  source: string | null
  /** Not on Stripe's object: the payout that paid it out, for `?payout=` */
  payout: string | null
}

export type FakePayout = {
  id: string
  object: "payout"
  amount: number
  currency: "usd"
  arrival_date: number
  created: number
  automatic: boolean
  method: "standard" | "instant"
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled"
  type: "bank_account"
  balance_transaction: string | null
  failure_code: string | null
  failure_message: string | null
  reconciliation_status: "completed" | "in_progress" | "not_applicable"
  statement_descriptor: null
  livemode: false
}

export type FakeRefund = {
  id: string
  object: "refund"
  amount: number
  currency: "usd"
  charge: string
  payment_intent: string | null
  balance_transaction: string | null
  created: number
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled"
  failure_reason?: string
  reason: string | null
  metadata: Record<string, string>
}

export type FakeDispute = {
  id: string
  object: "dispute"
  amount: number
  currency: "usd"
  charge: string
  payment_intent: string | null
  created: number
  reason: string
  status: string
  is_charge_refundable: boolean
  balance_transactions: FakeBalanceTransaction[]
  /** PII on the real object: the fake fills it with obviously fake values, so tests can check nothing stores it */
  evidence: { customer_name: string; customer_email_address: string }
  evidence_details: { due_by: number | null; has_evidence: boolean; past_due: boolean; submission_count: number }
  livemode: false
}

export type StripeFixtures = {
  now: number
  charges: FakeCharge[]
  transactions: FakeBalanceTransaction[]
  payouts: FakePayout[]
  refunds: FakeRefund[]
  disputes: FakeDispute[]
}

/** Stripe's US card fee: 2.9% + 30¢ */
const fee = (amount: number) => Math.round(amount * 0.029 + 30)

export function stripeFixtures(nowSeconds = Math.floor(Date.now() / 1000)): StripeFixtures {
  const now = nowSeconds
  const ago = (days: number) => now - Math.round(days * DAY)
  // Payouts land at 00:00 UTC on their arrival day, like Stripe's
  const arrival = (daysFromNow: number) => Math.floor((now + daysFromNow * DAY) / DAY) * DAY

  const charges: FakeCharge[] = []
  const transactions: FakeBalanceTransaction[] = []

  const charge = (key: string, amount: number, days: number, opts: { status?: FakeBalanceTransaction["status"]; payout?: string | null; purpose?: string; name?: string } = {}) => {
    const id = `ch_fake_${key}`
    const txn = `txn_fake_${key}`
    charges.push({
      id,
      object: "charge",
      amount,
      amount_captured: amount,
      amount_refunded: 0,
      currency: "usd",
      created: ago(days),
      status: "succeeded",
      paid: true,
      refunded: false,
      disputed: false,
      payment_intent: `pi_fake_${key}`,
      balance_transaction: txn,
      description: null,
      metadata: opts.purpose ? { purpose: opts.purpose } : {},
      billing_details: { name: opts.name ?? "Test Driver", email: `${key.replace(/_/g, "-")}@example.com`, address: null, phone: null },
      receipt_email: null,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
      livemode: false,
    })
    const f = fee(amount)
    transactions.push({
      id: txn,
      object: "balance_transaction",
      type: "charge",
      reporting_category: "charge",
      amount,
      fee: f,
      net: amount - f,
      currency: "usd",
      status: opts.status ?? "available",
      created: ago(days),
      available_on: ago(days - 2),
      source: id,
      payout: opts.payout ?? null,
    })
    return { id, net: amount - f }
  }

  const txn = (id: string, type: string, amount: number, days: number, source: string, payout: string | null, status: FakeBalanceTransaction["status"] = "available") => {
    transactions.push({ id, object: "balance_transaction", type, reporting_category: type, amount, fee: 0, net: amount, currency: "usd", status, created: ago(days), available_on: ago(days), source, payout })
  }

  // Paid out in po_fake_paid_1: two LSC entries
  const lsc1 = charge("lsc_1", 1000, 20, { payout: "po_fake_paid_1" })
  const lsc2 = charge("lsc_2", 500, 19, { payout: "po_fake_paid_1" })
  // Paid out in po_fake_paid_2: an entry later refunded in part, and a donation
  const lsc3 = charge("lsc_3", 1000, 12, { payout: "po_fake_paid_2" })
  const donation = charge("donation", 2500, 11, { payout: "po_fake_paid_2", purpose: "donation", name: "Test Donor" })
  txn("txn_fake_refund_partial", "refund", -500, 10, "re_fake_partial", "po_fake_paid_2")
  // In the payout on its way now: an entry whose refund failed (the money came back)
  const lsc6 = charge("lsc_6", 1000, 6, { payout: "po_fake_in_transit" })
  txn("txn_fake_refund_failed", "refund", -1000, 5, "re_fake_failed", "po_fake_in_transit")
  txn("txn_fake_refund_failure", "refund_failure", 1000, 4, "re_fake_failed", "po_fake_in_transit")
  // Not paid out yet: an event fee (in the pending payout), then two recent entries still pending, one of them disputed
  const event1 = charge("event_1", 4000, 5, { payout: "po_fake_pending" })
  charge("lsc_4", 1000, 3, { status: "pending" })
  charge("lsc_5", 1000, 2, { status: "pending" })
  // An older entry whose dispute the club won
  charge("lsc_old", 1000, 55)

  const paid1 = lsc1.net + lsc2.net
  const paid2 = lsc3.net + donation.net - 500
  const inTransit = lsc6.net
  const pending = event1.net
  txn("txn_fake_po_paid_1", "payout", -paid1, 15, "po_fake_paid_1", "po_fake_paid_1")
  txn("txn_fake_po_paid_2", "payout", -paid2, 8, "po_fake_paid_2", "po_fake_paid_2")
  txn("txn_fake_po_in_transit", "payout", -inTransit, 2, "po_fake_in_transit", "po_fake_in_transit")
  txn("txn_fake_po_pending", "payout", -pending, 1, "po_fake_pending", "po_fake_pending")

  const payout = (id: string, amount: number, created: number, arrivalDays: number, status: FakePayout["status"], opts: Partial<FakePayout> = {}): FakePayout => ({
    id,
    object: "payout",
    amount,
    currency: "usd",
    arrival_date: arrival(arrivalDays),
    created,
    automatic: true,
    method: "standard",
    status,
    type: "bank_account",
    balance_transaction: `txn_${id.slice(3)}`,
    failure_code: null,
    failure_message: null,
    reconciliation_status: status === "paid" ? "completed" : "in_progress",
    statement_descriptor: null,
    livemode: false,
    ...opts,
  })

  const payouts: FakePayout[] = [
    payout("po_fake_pending", pending, ago(1), 2, "pending"),
    payout("po_fake_in_transit", inTransit, ago(2), 1, "in_transit"),
    payout("po_fake_paid_2", paid2, ago(8), -6, "paid"),
    payout("po_fake_paid_1", paid1, ago(15), -13, "paid"),
    payout("po_fake_failed", 1880, ago(30), -28, "failed", { failure_code: "no_account", failure_message: "The bank account details on file are probably incorrect.", reconciliation_status: "not_applicable", balance_transaction: null }),
    payout("po_fake_manual", 5000, ago(40), -38, "paid", { automatic: false, reconciliation_status: "not_applicable", balance_transaction: null }),
  ]

  const refunds: FakeRefund[] = [
    { id: "re_fake_partial", object: "refund", amount: 500, currency: "usd", charge: lsc3.id, payment_intent: "pi_fake_lsc_3", balance_transaction: "txn_fake_refund_partial", created: ago(10), status: "succeeded", reason: "requested_by_customer", metadata: {} },
    { id: "re_fake_failed", object: "refund", amount: 1000, currency: "usd", charge: lsc6.id, payment_intent: "pi_fake_lsc_6", balance_transaction: "txn_fake_refund_failed", created: ago(5), status: "failed", failure_reason: "expired_or_canceled_card", reason: "requested_by_customer", metadata: {} },
  ]
  const refunded = charges.find((c) => c.id === lsc3.id)
  if (refunded) refunded.amount_refunded = 500

  const disputes: FakeDispute[] = [
    {
      id: "du_fake_open",
      object: "dispute",
      amount: 1000,
      currency: "usd",
      charge: "ch_fake_lsc_5",
      payment_intent: "pi_fake_lsc_5",
      created: ago(1),
      reason: "fraudulent",
      status: "warning_needs_response",
      is_charge_refundable: true,
      balance_transactions: [],
      evidence: { customer_name: "Test Cardholder", customer_email_address: "cardholder@example.com" },
      evidence_details: { due_by: now + 3 * DAY, has_evidence: false, past_due: false, submission_count: 0 },
      livemode: false,
    },
    {
      id: "du_fake_won",
      object: "dispute",
      amount: 1000,
      currency: "usd",
      charge: "ch_fake_lsc_old",
      payment_intent: "pi_fake_lsc_old",
      created: ago(50),
      reason: "product_not_received",
      status: "won",
      is_charge_refundable: false,
      balance_transactions: [],
      evidence: { customer_name: "Test Cardholder", customer_email_address: "cardholder@example.com" },
      evidence_details: { due_by: ago(40), has_evidence: true, past_due: false, submission_count: 1 },
      livemode: false,
    },
  ]
  for (const dispute of disputes) {
    const disputed = charges.find((c) => c.id === dispute.charge)
    if (disputed) disputed.disputed = true
  }

  return { now, charges, transactions, payouts, refunds, disputes }
}

/** The balance the fixtures' transactions leave: settled and not paid out is available; not settled yet is pending */
export function fixtureBalance(transactions: FakeBalanceTransaction[], payouts: FakePayout[]) {
  const paidOut = new Set(payouts.filter((p) => p.status !== "failed" && p.status !== "canceled").map((p) => p.id))
  let available = 0
  let pending = 0
  for (const t of transactions) {
    if (t.type === "payout") continue
    if (t.payout && paidOut.has(t.payout)) continue
    if (t.status === "pending") pending += t.net
    else available += t.net
  }
  return { available, pending }
}
