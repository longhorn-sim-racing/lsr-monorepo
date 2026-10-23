import type { Metadata } from "next"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Plus } from "lucide-react"
import { Badge, Button, CellStack, EmptyState, PageHeader, Panel, PanelBody, PanelHeader, Stat, StatRow, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { SPONSORS } from "@/lib/sponsors"
import { activityLabel, daysSince, prospectPath, QUIET_PROSPECT_DAYS, TIER_LABEL } from "@/lib/sponsor-prospects"
import { requireOfficerPage } from "@/server/auth/guards"
import { inProspectView, isProspectView, listProspects, PROSPECT_VIEWS, type ProspectRow, type ProspectView } from "@/server/queries/sponsor-prospects"
import { hostOf, StageBadge } from "./_components/labels"
import { ProspectFilters } from "./_components/prospect-filters"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Sponsors" }

const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d")

const EMPTY: Record<ProspectView, { title: string; description: string }> = {
  active: { title: "No prospects being worked on", description: "Add a company the club could approach for sponsorship, or ask Jack to add a list of them." },
  committed: { title: "No committed prospects yet", description: "Prospects show up here when their stage is Committed." },
  quiet: { title: "Nothing quiet", description: `Prospects in Contacted or Talking show up here after ${QUIET_PROSPECT_DAYS} days with nothing logged.` },
  closed: { title: "Nothing declined or dormant", description: "Prospects that said no, or went quiet for good, show up here." },
  all: { title: "No sponsor prospects yet", description: "Add a company the club could approach for sponsorship, or ask Jack to add a list of them." },
}

function matches(row: ProspectRow, q: string): boolean {
  const text = [row.company, row.contactName, row.contactRole, row.contactEmail, row.nextStep, row.notes, row.website].filter(Boolean).join(" ").toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
}

/**
 * Club → Sponsors (#188, design §13): sponsor prospects, the companies the club is courting. Officers
 * add and edit them and log activity on each one's page; Jack proposes the same changes. The sponsors
 * on the website are set in the site's code and listed at the bottom for reference.
 */
export default async function SponsorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()
  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return (Array.isArray(value) ? value[0] : value) ?? ""
  }
  const view: ProspectView = isProspectView(one("view")) ? (one("view") as ProspectView) : "active"
  const owner = one("owner")
  const q = one("q").trim().slice(0, 200)
  const now = new Date()

  const all = await listProspects(now)
  const owned = all.filter((row) => (owner === "none" ? !row.owner : !owner || row.owner?.handle === owner))
  const counts = Object.fromEntries(PROSPECT_VIEWS.map((v) => [v, owned.filter((row) => inProspectView(row, v) && (!q || matches(row, q))).length])) as Record<ProspectView, number>
  const rows = owned.filter((row) => inProspectView(row, view) && (!q || matches(row, q)))
  const owners = [...new Map(all.flatMap((row) => (row.owner ? [[row.owner.handle, row.owner] as const] : []))).values()].sort((a, b) => a.displayName.localeCompare(b.displayName))

  const working = all.filter((row) => inProspectView(row, "active"))
  const talking = all.filter((row) => row.stage === "talking").length

  return (
    <>
      <PageHeader
        title="Sponsors"
        description="Sponsor prospects: companies the club is talking to about sponsorship, who's handling each, and what happened last."
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/sponsors/new">
              <Plus aria-hidden />
              New prospect
            </Link>
          </Button>
        }
      />

      <StatRow>
        <Stat label="Being worked on" value={working.length} hint={`${talking} talking`} />
        <Stat label="Committed" value={all.filter((row) => row.stage === "committed").length} />
        <Stat label="Quiet" value={all.filter((row) => row.quiet).length} hint={`Nothing logged in ${QUIET_PROSPECT_DAYS}+ days`} />
        <Stat label="Next steps overdue" value={all.filter((row) => row.nextStepOverdue).length} />
      </StatRow>

      <ProspectFilters counts={counts} owners={owners} />

      {rows.length === 0 ? (
        <Panel>
          {q || owner ? (
            <EmptyState title="No prospects match" description="Try other words, another owner, or another view." />
          ) : (
            <EmptyState
              {...EMPTY[view]}
              action={
                view === "active" || view === "all" ? (
                  <Button asChild>
                    <Link href="/admin/sponsors/new">New prospect</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      ) : (
        <Table minWidth={860}>
          <THead>
            <TH>Company</TH>
            <TH>Stage</TH>
            <TH>Owner</TH>
            <TH>Last activity</TH>
            <TH>Next step</TH>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD className="max-w-[260px]">
                  <CellStack
                    primary={
                      <Link href={prospectPath(row.id)} className="hover:underline">
                        {row.company}
                      </Link>
                    }
                    secondary={[row.contactName && `${row.contactName}${row.contactRole ? `, ${row.contactRole}` : ""}`, !row.contactName && row.website ? hostOf(row.website) : null].filter(Boolean).join(" · ") || undefined}
                  />
                </TD>
                <TD className="whitespace-nowrap">
                  <span className="flex flex-col items-start gap-1">
                    <StageBadge stage={row.stage} />
                    {row.tierInterest && <span className="text-xs text-admin-subtle">{TIER_LABEL[row.tierInterest as keyof typeof TIER_LABEL] ?? row.tierInterest} interest</span>}
                  </span>
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">{row.owner?.displayName ?? <span className="text-admin-subtle">No owner</span>}</TD>
                <TD className="whitespace-nowrap">
                  <span className="flex flex-col gap-0.5">
                    <span>{row.lastActivity ? `${activityLabel(row.lastActivity.type)}, ${day(row.lastActivity.occurredAt)}` : <span className="text-admin-subtle">Nothing logged</span>}</span>
                    {row.quiet ? <Badge tone="warning">Quiet {daysSince(row.lastTouchAt, now)} days</Badge> : null}
                  </span>
                </TD>
                <TD className="max-w-[300px]">
                  {row.nextStep ? (
                    <span className="flex flex-col gap-0.5">
                      <span className="line-clamp-2">{row.nextStep}</span>
                      {row.nextStepDue && (row.nextStepOverdue ? <Badge tone="warning">Was due {day(row.nextStepDue)}</Badge> : <span className="text-xs text-admin-subtle">Due {day(row.nextStepDue)}</span>)}
                    </span>
                  ) : (
                    <span className="text-admin-subtle">None set</span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}

      <Panel className="mt-4">
        <PanelHeader title="On the website now" description="The sponsors the site shows. They're set in the site's code, not here; the Tech Team changes them." />
        <PanelBody>
          <ul className="flex flex-wrap gap-2 text-[13px]">
            {SPONSORS.map((sponsor) => (
              <li key={sponsor.name} className="flex items-center gap-1.5 rounded-md border bg-admin-surface px-2.5 py-1">
                <span className="font-medium">{sponsor.name}</span>
                <span className="text-xs text-admin-subtle">{TIER_LABEL[sponsor.tier as keyof typeof TIER_LABEL] ?? sponsor.tier}</span>
              </li>
            ))}
          </ul>
        </PanelBody>
      </Panel>
    </>
  )
}
