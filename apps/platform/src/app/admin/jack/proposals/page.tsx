import type { Metadata } from "next"
import Link from "next/link"
import { Badge, EmptyState, PageHeader, Pager, Panel, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { isProposalStatus, PROPOSAL_STATUS, PROPOSALS_PAGE, roomMessageUrl } from "@/lib/jack/proposals"
import { jackRoomTitle } from "@/lib/jack/types"
import { requireOfficerPage } from "@/server/auth/guards"
import { listProposals, type ProposalListFilters } from "@/server/jack/proposals/list"
import { ProposalsFilters } from "./proposals-filters"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Proposals · Jack" }

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const MAX_PAGE = 10_000

/** Every change Jack proposed (#188, design §4): open ones first, then the rest, newest first */
export default async function JackProposalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()

  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }
  const status = one("status")
  const kind = (one("kind") ?? "").trim().slice(0, 100)
  const page = Number.parseInt(one("page") ?? "", 10)
  const filters: ProposalListFilters = {
    status: isProposalStatus(status) ? status : null,
    kind: kind || null,
    page: Number.isInteger(page) && page > 0 ? Math.min(page, MAX_PAGE) : 1,
  }

  const list = await listProposals(filters)
  const hrefFor = (n: number) => {
    const query = new URLSearchParams()
    if (filters.status) query.set("status", filters.status)
    if (filters.kind) query.set("kind", filters.kind)
    if (n > 1) query.set("page", String(n))
    const text = query.toString()
    return text ? `${PROPOSALS_PAGE}?${text}` : PROPOSALS_PAGE
  }
  const open = list.counts.PENDING + list.counts.APPLYING
  const everything = Object.values(list.counts).reduce((sum, n) => sum + n, 0)

  return (
    <>
      <PageHeader
        title="Proposals"
        back={{ href: "/admin/jack", label: "Jack" }}
        description={`Changes Jack proposed in the rooms; an officer applies or discards each one on its card in the room · ${open} waiting · ${list.counts.APPLIED} applied`}
      />
      <ProposalsFilters kinds={list.kinds} counts={list.counts} />

      {list.items.length === 0 ? (
        <Panel>
          <EmptyState
            title={everything === 0 ? "No proposals yet" : "No proposals match"}
            description={
              everything === 0
                ? "When an officer asks Jack to change something (a page's text, say), he proposes it in the room, and it shows up here."
                : "Try another status or kind, or clear the filters."
            }
          />
        </Panel>
      ) : (
        <div className="flex flex-col">
          <Table minWidth={760}>
            <THead>
              <TH>Proposal</TH>
              <TH>Status</TH>
              <TH>Room</TH>
              <TH>Proposed</TH>
              <TH>Decided</TH>
            </THead>
            <tbody>
              {list.items.map((item) => {
                const { label, tone } = PROPOSAL_STATUS[item.status]
                return (
                  <TR key={item.id}>
                    <TD className="max-w-[340px] align-top">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <Link href={roomMessageUrl(item.roomId, item.messageId)} className="break-words font-semibold hover:underline">
                          {item.title}
                        </Link>
                        <span className="text-xs text-admin-subtle">{item.kind}</span>
                        {item.summary && <span className="line-clamp-2 break-words text-xs text-muted-foreground">{item.summary}</span>}
                      </div>
                    </TD>
                    <TD className="max-w-[240px] align-top">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={tone}>{label}</Badge>
                        {item.result && item.status !== "PENDING" && <span className="line-clamp-2 break-words text-xs text-admin-subtle">{item.result}</span>}
                      </div>
                    </TD>
                    <TD className="max-w-[200px] align-top">
                      <Link href={roomMessageUrl(item.roomId, item.messageId)} className="line-clamp-2 break-words text-muted-foreground hover:text-foreground hover:underline">
                        {jackRoomTitle({ title: item.roomTitle })}
                      </Link>
                    </TD>
                    <TD className="whitespace-nowrap align-top text-muted-foreground">
                      <div className="flex flex-col">
                        <span>{when.format(item.createdAt)} CT</span>
                        {item.proposedFor && <span className="text-xs text-admin-subtle">for {item.proposedFor}</span>}
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap align-top text-muted-foreground">
                      {item.decidedAt ? (
                        <div className="flex flex-col">
                          <span>{when.format(item.decidedAt)} CT</span>
                          {item.decidedBy && <span className="text-xs text-admin-subtle">by {item.decidedBy}</span>}
                        </div>
                      ) : (
                        <span className="text-admin-subtle">—</span>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
          {list.pageCount > 1 && (
            <Pager
              page={Math.min(filters.page, list.pageCount)}
              pageCount={list.pageCount}
              hrefFor={hrefFor}
              summary={`${list.total.toLocaleString("en-US")} proposal${list.total === 1 ? "" : "s"}`}
            />
          )}
        </div>
      )}
    </>
  )
}
