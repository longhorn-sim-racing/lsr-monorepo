import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Button, EmptyState, Pager, Panel, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { knowledgeAge, knowledgeEntryPath } from "@/lib/jack/knowledge"
import { isKnowledgeView, KNOWLEDGE_PAGE_SIZE, listKnowledgeEntries, type KnowledgeView } from "@/server/jack/knowledge/queries"
import type { KnowledgeSearchParams } from "../_tabs/types"
import { AgeBadge, EntryStatus, SOURCE_LABEL } from "./labels"
import { KnowledgeFilters } from "./knowledge-filters"

const EMPTY: Record<KnowledgeView, { title: string; description: string }> = {
  active: { title: "No knowledge entries yet", description: "Entries hold what the club wants remembered: decisions, how-tos, policies, who does what. Write one here, or ask Jack to remember something in a room." },
  unreviewed: { title: "Nothing to review", description: "Entries Jack saves or changes show up here until an officer marks them reviewed." },
  stale: { title: "Nothing over 6 months old", description: "Entries show up here when they haven't been reviewed (or edited) in 180 days." },
  archived: { title: "Nothing archived", description: "Archived entries are hidden from Jack's search but keep their history." },
}

/** The Entries tab: the knowledge base, searchable, by view, 50 to a page */
export async function EntriesTab({ searchParams }: { searchParams: KnowledgeSearchParams }) {
  const one = (key: string) => {
    const value = searchParams[key]
    return Array.isArray(value) ? value[0] : value
  }
  const viewParam = one("view")
  const view: KnowledgeView = isKnowledgeView(viewParam) ? viewParam : "active"
  const q = (one("q") ?? "").trim().slice(0, 200)
  const pageParam = Number.parseInt(one("page") ?? "", 10)
  const now = new Date()
  const list = await listKnowledgeEntries({ q, view, page: Number.isInteger(pageParam) && pageParam > 0 ? Math.min(pageParam, 10_000) : 1, now })

  const hrefFor = (page: number) => {
    const params = new URLSearchParams()
    for (const key of ["tab", "q", "view"]) {
      const value = one(key)
      if (value) params.set(key, value)
    }
    if (page > 1) params.set("page", String(page))
    const query = params.toString()
    return query ? `/admin/knowledge?${query}` : "/admin/knowledge"
  }
  const first = (list.page - 1) * KNOWLEDGE_PAGE_SIZE + 1

  return (
    <>
      <KnowledgeFilters counts={list.counts} />
      {list.rows.length === 0 ? (
        <Panel>
          {q ? (
            <EmptyState title="No entries match" description={`Nothing in this view matches “${q}”. Try other words, or another view.`} />
          ) : (
            <EmptyState
              {...EMPTY[view]}
              action={
                view === "active" ? (
                  <Button asChild>
                    <Link href="/admin/knowledge/new">New entry</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      ) : (
        <>
          <Table minWidth={720}>
            <THead>
              <TH>Entry</TH>
              <TH>Source</TH>
              <TH>Age</TH>
              <TH>Owner</TH>
              <TH className="text-right">Updated</TH>
            </THead>
            <tbody>
              {list.rows.map((row) => (
                <TR key={row.id}>
                  <TD className="max-w-[420px]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link href={knowledgeEntryPath(row.id)} className="font-semibold hover:underline">
                        {row.title}
                      </Link>
                      <EntryStatus unreviewed={row.unreviewed} archived={!!row.archivedAt} />
                    </div>
                    {row.tags.length > 0 && <div className="truncate text-xs text-admin-subtle">{row.tags.join(" · ")}</div>}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{SOURCE_LABEL[row.sourceType]}</TD>
                  <TD className="whitespace-nowrap">
                    <AgeBadge age={knowledgeAge(row, now)} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{row.owner?.displayName ?? <span className="text-admin-subtle">No owner</span>}</TD>
                  <TD className="whitespace-nowrap text-right text-muted-foreground">{formatInTimeZone(row.updatedAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <Pager page={list.page} pageCount={list.pageCount} hrefFor={hrefFor} summary={`${first}–${first + list.rows.length - 1} of ${list.total}`} />
        </>
      )}
    </>
  )
}
