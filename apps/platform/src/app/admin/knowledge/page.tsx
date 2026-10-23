import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button, PageHeader } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import { requireOfficerPage } from "@/server/auth/guards"
import { findKnowledgeTab, KNOWLEDGE_TABS } from "./_tabs"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Knowledge" }

/**
 * Content → Knowledge (#188, design §9 and §13): the knowledge base Jack searches, plus the tabs other
 * tracks register (Documents, Teams messages). Each tab loads its own data from the search params.
 */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()
  const params = await searchParams
  const tabParam = Array.isArray(params.tab) ? params.tab[0] : params.tab
  const active = findKnowledgeTab(tabParam)

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What the club wants remembered. Jack searches it and cites it, and saves to it when an officer asks."
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/knowledge/new">
              <Plus aria-hidden />
              New entry
            </Link>
          </Button>
        }
      />
      {KNOWLEDGE_TABS.length > 1 && (
        <nav aria-label="Knowledge sections" className="mb-4 flex gap-4 overflow-x-auto border-b">
          {KNOWLEDGE_TABS.map((tab) => {
            const current = tab.id === active?.id
            return (
              <Link
                key={tab.id}
                href={tab === KNOWLEDGE_TABS[0] ? "/admin/knowledge" : `/admin/knowledge?tab=${encodeURIComponent(tab.id)}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex shrink-0 items-center border-b-2 px-0.5 pb-2 text-[13px] outline-none focus-visible:text-foreground",
                  current ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
      )}
      {active ? <active.Tab searchParams={params} /> : null}
    </>
  )
}
