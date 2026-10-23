import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Badge, Button, CellStack, EmptyState, PageHeader, Panel, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { formatMeetingTime, isMeetingType, MEETING_TYPES, meetingPath, meetingTypeLabel, type MeetingType } from "@/lib/meetings"
import { requireOfficerPage } from "@/server/auth/guards"
import { listMeetings } from "@/server/queries/meetings"
import { MeetingFilters } from "./_components/meeting-filters"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Meetings" }

/**
 * Club → Meetings (#188, design §13): meeting records with their agenda, summary, decisions and action
 * items. Officers record them here, or Jack proposes them (from notes or a transcript in a room).
 */
export default async function MeetingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOfficerPage()
  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return (Array.isArray(value) ? value[0] : value) ?? ""
  }
  const q = one("q").trim().slice(0, 200)
  const type = isMeetingType(one("type")) ? (one("type") as MeetingType) : null

  const found = await listMeetings({ query: q || undefined })
  const counts = Object.fromEntries([["all", found.length], ...MEETING_TYPES.map((t) => [t, found.filter((m) => m.kind === t).length])]) as Record<MeetingType | "all", number>
  const rows = type ? found.filter((m) => m.kind === type) : found

  return (
    <>
      <PageHeader
        title="Meetings"
        description="Meeting records: agenda, summary, decisions and action items. Decisions also go to the decision log in Knowledge."
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/meetings/new">
              <Plus aria-hidden />
              New meeting
            </Link>
          </Button>
        }
      />
      <MeetingFilters counts={counts} />
      {rows.length === 0 ? (
        <Panel>
          {q || type ? (
            <EmptyState title="No meetings match" description="Try other words, or another type." />
          ) : (
            <EmptyState
              title="No meetings recorded yet"
              description="Record one here with its agenda, or after it with its summary, decisions and action items. In a Jack room, attach the transcript and ask Jack to record the meeting."
              action={
                <Button asChild>
                  <Link href="/admin/meetings/new">New meeting</Link>
                </Button>
              }
            />
          )}
        </Panel>
      ) : (
        <Table minWidth={680}>
          <THead>
            <TH>Meeting</TH>
            <TH>Type</TH>
            <TH className="text-right">Decisions</TH>
            <TH className="text-right">Action items</TH>
          </THead>
          <tbody>
            {rows.map((m) => (
              <TR key={m.id}>
                <TD className="max-w-[380px]">
                  <CellStack
                    primary={
                      <Link href={meetingPath(m.id)} className="hover:underline">
                        {m.title}
                      </Link>
                    }
                    secondary={[formatMeetingTime(m.heldAt), !m.hasSummary && !m.hasAgenda ? "No agenda or summary yet" : !m.hasSummary ? "Agenda only" : null].filter(Boolean).join(" · ")}
                  />
                </TD>
                <TD className="whitespace-nowrap">
                  <Badge>{meetingTypeLabel(m.kind)}</Badge>
                </TD>
                <TD className="text-right">{m.decisions || <span className="text-admin-subtle">0</span>}</TD>
                <TD className="whitespace-nowrap text-right">
                  {m.actionItems ? (
                    <span>
                      {m.openItems} open <span className="text-admin-subtle">of {m.actionItems}</span>
                    </span>
                  ) : (
                    <span className="text-admin-subtle">0</span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
