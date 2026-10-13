import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { requireOfficerPage } from "@/server/auth/guards"
import { getProductById } from "@/server/queries/products"
import { getSeasonSlugOptions } from "@/server/queries/seasons"
import { Badge, Notice, PageHeader } from "@/components/admin/kit"
import { ProductEditForm, type SeasonOption } from "@/components/admin/product-edit-form"
import { readProductMetadataFields } from "@/schemas/product.schema"
import { formatCents } from "@/lib/money"
import { PRODUCT_TYPE_LABELS } from "@/lib/payments"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Edit product" }

export default async function AdminProductEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params

  const [product, seasons] = await Promise.all([getProductById(id), getSeasonSlugOptions()])
  if (!product) notFound()

  const fields = readProductMetadataFields(product.metadata)

  // Saved slugs that aren't Seasons (the seed uses series slugs) stay listed so saving keeps them.
  const seasonSlugs = new Set(seasons.map((s) => s.slug))
  const seasonOptions: SeasonOption[] = [
    ...seasons.map((s) => ({ slug: s.slug, name: s.name })),
    ...fields.returningSeasonSlugs.filter((slug) => !seasonSlugs.has(slug)).map((slug) => ({ slug, name: null })),
  ]

  return (
    <>
      <PageHeader
        back={{ href: "/admin/products", label: "Products" }}
        title={product.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={product.active ? "success" : "neutral"}>{product.active ? "Active" : "Inactive"}</Badge>
            {PRODUCT_TYPE_LABELS[product.type]}
            {product.league && ` · ${product.league.name}`}
            {` · ${formatCents(product.amountCents)} ${product.currency}`}
          </span>
        }
      />

      <div className="flex max-w-3xl flex-col gap-4">
        {product.active && (
          <Notice tone="warning" title="This product is live">
            Changes apply to new checkouts right away.
          </Notice>
        )}

        <ProductEditForm
          product={{
            id: product.id,
            type: product.type,
            name: product.name,
            amountCents: product.amountCents,
            active: product.active,
            ...fields,
          }}
          seasonOptions={seasonOptions}
        />
      </div>
    </>
  )
}
