"use client"

import { Pager } from "@/components/admin/kit"
import type { PaymentFilters } from "@/server/queries/payments"

function pageHref({ status, kind, q }: PaymentFilters, page: number) {
  const params = new URLSearchParams()
  if (status) params.set("status", status)
  if (kind) params.set("kind", kind)
  if (q) params.set("q", q)
  if (page > 1) params.set("page", String(page))
  const query = params.toString()
  return query ? `/admin/payments?${query}` : "/admin/payments"
}

/** The kit Pager, with links that keep the payments filters. A client component because Pager takes a function. */
export function PaymentsPager({ filters, pageCount, summary }: { filters: PaymentFilters; pageCount: number; summary: string }) {
  return <Pager page={filters.page} pageCount={pageCount} hrefFor={(page) => pageHref(filters, page)} summary={summary} />
}
