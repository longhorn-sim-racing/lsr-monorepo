"use client"

import Link from "next/link"
import { Badge, CellStack, DataTable, EmptyState, ToneText, type Column } from "@/components/admin/kit"
import { formatCents } from "@/lib/money"
import { PRODUCT_TYPE_LABELS } from "@/lib/payments"
import { readProductMetadataFields } from "@/schemas/product.schema"
import type { AdminProduct } from "@/server/queries/products"

const editHref = (product: AdminProduct) => `/admin/products/${product.id}`

const columns: Column<AdminProduct>[] = [
  {
    id: "name",
    header: "Product",
    sortValue: (p) => p.name,
    cell: (p) => (
      <CellStack
        primary={
          <Link href={editHref(p)} className="hover:underline">
            {p.name}
          </Link>
        }
        secondary={PRODUCT_TYPE_LABELS[p.type]}
      />
    ),
  },
  {
    id: "league",
    header: "League",
    hideBelow: "md",
    cell: (p) => p.league?.name ?? <span className="text-admin-subtle">—</span>,
  },
  {
    id: "price",
    header: "Price",
    align: "right",
    sortValue: (p) => p.amountCents,
    cell: (p) => <span className="font-semibold">{formatCents(p.amountCents)}</span>,
  },
  {
    id: "returning",
    header: "Returning rate",
    align: "right",
    hideBelow: "sm",
    cell: (p) => {
      const { returningAmountCents, returningSeasonSlugs } = readProductMetadataFields(p.metadata)
      if (p.type !== "LEAGUE_FEE" || returningAmountCents === null) return <span className="text-admin-subtle">—</span>
      return (
        <div className="flex flex-col items-end">
          <span className="font-semibold">{formatCents(returningAmountCents)}</span>
          <span className="text-xs text-admin-subtle">
            {returningSeasonSlugs.length} {returningSeasonSlugs.length === 1 ? "season" : "seasons"}
          </span>
        </div>
      )
    },
  },
  {
    id: "rules",
    header: "Entry rules",
    hideBelow: "lg",
    cell: (p) =>
      p.type === "LEAGUE_FEE" && readProductMetadataFields(p.metadata).requiresMembership ? (
        <ToneText>Dues required</ToneText>
      ) : (
        <span className="text-admin-subtle">—</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (p) => p.active,
    cell: (p) => <Badge tone={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Inactive"}</Badge>,
  },
]

export function ProductsConsole({ products }: { products: AdminProduct[] }) {
  return (
    <DataTable
      rows={products}
      columns={columns}
      getRowId={(p) => p.id}
      rowHref={editHref}
      noun={{ one: "product", many: "products" }}
      minWidth={420}
      empty={<EmptyState title="No products" description="Products are created by the seed script. Ask the Tech Team to add one." />}
    />
  )
}
