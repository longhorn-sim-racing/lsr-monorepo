import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageForm } from "@/components/admin/page-form"

export const metadata: Metadata = { title: "Edit page" }

export default async function EditAdminPagePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const page = await prisma.page.findUnique({ where: { id } })
  if (!page) notFound()

  return (
    <PageForm
      // A fresh form after navigating between pages, so one page's text never carries into another
      key={page.id}
      id={page.id}
      initial={{
        title: page.title,
        slug: page.slug,
        visibility: page.visibility === "public" ? "public" : "officers",
        bodyMd: page.bodyMd,
      }}
    />
  )
}
