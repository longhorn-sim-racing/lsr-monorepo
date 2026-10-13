import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { getAllProducts } from "@/server/queries/products"
import { PageHeader } from "@/components/admin/kit"
import { ProductsConsole } from "@/components/admin/products-console"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Products" }

export default async function AdminProductsPage() {
  await requireOfficerPage()
  const products = await getAllProducts()

  return (
    <>
      <PageHeader title="Products" description="What the site charges at checkout. Open a product to change its price or who can buy it." />
      <ProductsConsole products={products} />
    </>
  )
}
