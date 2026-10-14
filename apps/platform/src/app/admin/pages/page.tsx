import type { Metadata } from "next"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Plus } from "lucide-react"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { Badge, Button, EmptyState, PageHeader, Panel, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { PAGE_PUBLIC_PATHS } from "@/app/admin/pages/_components/public-paths"

export const metadata: Metadata = { title: "Pages" }

export default async function AdminPagesPage() {
  await requireOfficerPage()
  const pages = await prisma.page.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, slug: true, visibility: true, updatedAt: true },
  })
  const published = pages.filter((p) => p.visibility === "public").length

  return (
    <>
      <PageHeader
        title="Pages"
        description={`Editable content pages, like the LSC rules · ${published} of ${pages.length} published`}
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/pages/new">
              <Plus aria-hidden />
              New page
            </Link>
          </Button>
        }
      />

      {pages.length === 0 ? (
        <Panel>
          <EmptyState
            title="No pages yet"
            description="Pages hold longer content the site shows, like the Lone Star Cup rules."
            action={
              <Button asChild>
                <Link href="/admin/pages/new">New page</Link>
              </Button>
            }
          />
        </Panel>
      ) : (
        <Table minWidth={480}>
          <THead>
            <TH>Title</TH>
            <TH>Shown at</TH>
            <TH>Status</TH>
            <TH className="text-right">Updated</TH>
          </THead>
          <tbody>
            {pages.map((p) => {
              const path = PAGE_PUBLIC_PATHS[p.slug]
              return (
                <TR key={p.id}>
                  <TD>
                    <Link href={`/admin/pages/${p.id}`} className="font-semibold hover:underline">
                      {p.title}
                    </Link>
                    <div className="text-xs text-admin-subtle">{p.slug}</div>
                  </TD>
                  <TD className="text-muted-foreground">{path ?? <span className="text-admin-subtle">Not linked yet</span>}</TD>
                  <TD>{p.visibility === "public" ? <Badge tone="success">Public</Badge> : <Badge>Draft</Badge>}</TD>
                  <TD className="whitespace-nowrap text-right text-muted-foreground">{formatInTimeZone(p.updatedAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</TD>
                </TR>
              )
            })}
          </tbody>
        </Table>
      )}
    </>
  )
}
