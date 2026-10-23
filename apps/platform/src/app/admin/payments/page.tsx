import type { Metadata } from "next"
import { ExternalLink } from "lucide-react"
import { requireOfficerPage } from "@/server/auth/guards"
import { getAdminPayments, type PaymentFilters } from "@/server/queries/payments"
import { Button, PageHeader } from "@/components/admin/kit"
import { PaymentsConsole } from "@/components/admin/payments-console"
import { SafeSlot } from "@/components/admin/safe-slot"
import { isPaymentKind, isPaymentStatus } from "@/lib/payments"
import { openDisputesFor } from "@/server/connectors/stripe/read"
import { StripePanel } from "./_components/stripe-panel"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Payments" }

const MAX_PAGE = 10_000

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()

  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const status = one("status")
  const kind = one("kind")
  const page = Number.parseInt(one("page") ?? "", 10)
  const filters: PaymentFilters = {
    status: isPaymentStatus(status) ? status : null,
    kind: isPaymentKind(kind) ? kind : null,
    q: (one("q") ?? "").trim().slice(0, 100),
    page: Number.isInteger(page) && page > 0 ? Math.min(page, MAX_PAGE) : 1,
  }

  const data = await getAdminPayments(filters)
  // Open disputes on this page's payments, from the Stripe sync (empty until it runs)
  const disputes = await openDisputesFor(data.payments.map((p) => p.providerRef)).catch((error: unknown) => {
    console.error("[payments] Couldn't read Stripe disputes:", error)
    return new Map()
  })

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every checkout on the site, newest first. Refunds happen in Stripe."
        actions={
          <Button asChild>
            <a href="https://dashboard.stripe.com/payments" target="_blank" rel="noopener noreferrer">
              Stripe dashboard
              <ExternalLink aria-hidden />
            </a>
          </Button>
        }
      />
      {filters.page === 1 && <SafeSlot id="stripe" where="payments" render={StripePanel} />}
      <PaymentsConsole filters={filters} {...data} disputes={Object.fromEntries(disputes)} />
    </>
  )
}
