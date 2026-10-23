import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { ClipboardList } from "lucide-react"
import { Badge, Button, DetailList, EmptyState, PageHeader, Panel, PanelBody, PanelHeader, SplitLayout } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { knowledgeEntryPath, roomMessagePath } from "@/lib/jack/knowledge"
import { partLink } from "@/lib/jack/links"
import { formatMeetingTime, meetingAgendaPath, meetingTimeInput, meetingTypeLabel } from "@/lib/meetings"
import { requireOfficerPage } from "@/server/auth/guards"
import { DOCUMENT_SOURCE_LABEL } from "@/server/connectors/documents/sources"
import { getMeetingDetail } from "@/server/queries/meetings"
import { listOfficers } from "@/server/services/officers"
import { ActionItemList, AddActionItemForm } from "../../action-items/_components/action-items"
import { actionItemView } from "../../action-items/_components/view"
import { MarkdownText } from "../_components/markdown-text"
import { MeetingForm } from "../_components/meeting-form"
import { AddDecisionForm, DecisionMenu, DeleteMeetingButton } from "../_components/meeting-parts"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Meeting" }

const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, yyyy")

/** A Drive or SharePoint document, with the host it opens on */
function DocumentLink({ name, url }: { name: string; url: string }) {
  const link = partLink(url)
  if (!link) return <span>{name}</span>
  return (
    <a href={link.href} target="_blank" rel="noreferrer" className="break-all font-medium hover:underline">
      {name} <span className="text-xs font-normal text-admin-subtle">({link.internal ? "this site" : link.host})</span>
    </a>
  )
}

/** Where a synced transcript lives: "Synced from Google Drive · Club/Meetings/Transcripts", or that it's gone there */
function transcriptSource(doc: { source: string; path: string; deletedAt: Date | null }): string {
  const from = DOCUMENT_SOURCE_LABEL[doc.source] ?? doc.source
  if (doc.deletedAt) return `Removed from ${from} since`
  return `Synced from ${from}${doc.path ? ` · ${doc.path}` : ""}`
}

/** One meeting: agenda, summary, decisions and action items, with the meeting's details to edit */
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const now = new Date()
  const [detail, officers] = await Promise.all([getMeetingDetail(id, now), listOfficers()])
  if (!detail) notFound()
  const { meeting } = detail
  const pickers = officers.map((o) => ({ id: o.id, displayName: o.displayName }))
  const open = detail.actionItems.filter((item) => item.status === "open").length

  return (
    <>
      <PageHeader
        back={{ href: "/admin/meetings", label: "Meetings" }}
        title={meeting.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge>{meetingTypeLabel(meeting.kind)}</Badge>
            <span>{formatMeetingTime(meeting.heldAt)}</span>
          </span>
        }
        actions={
          <>
            {meeting.agendaMd && (
              <Button asChild>
                <Link href={meetingAgendaPath(meeting.id)}>
                  <ClipboardList aria-hidden />
                  Agenda to copy
                </Link>
              </Button>
            )}
            <DeleteMeetingButton id={meeting.id} title={meeting.title} />
          </>
        }
      />

      <SplitLayout
        main={
          <div className="flex flex-col gap-4">
            <Panel>
              <PanelHeader title="Agenda" />
              <PanelBody>{meeting.agendaMd ? <MarkdownText text={meeting.agendaMd} /> : <p className="text-[13px] text-admin-subtle">No agenda yet. Add one in the details.</p>}</PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="Summary" />
              <PanelBody>{meeting.summaryMd ? <MarkdownText text={meeting.summaryMd} /> : <p className="text-[13px] text-admin-subtle">No summary yet. Add one in the details once the meeting has happened.</p>}</PanelBody>
            </Panel>

            <Panel>
              <PanelHeader title="Decisions" description="Each one is also in the decision log in Knowledge, tagged decision." />
              {detail.decisions.length > 0 ? (
                <ol className="flex flex-col">
                  {detail.decisions.map((decision) => (
                    <li key={decision.id} className="flex items-start justify-between gap-3 border-b border-admin-row px-4 py-2.5 text-[13px]">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="whitespace-pre-wrap break-words">{decision.text}</p>
                        {decision.knowledge ? (
                          <Link href={knowledgeEntryPath(decision.knowledge.id)} className="w-fit text-xs text-admin-subtle hover:text-foreground hover:underline">
                            In the decision log{decision.knowledge.archived ? " (archived)" : ""}: {decision.knowledge.title}
                          </Link>
                        ) : (
                          <span className="text-xs text-admin-subtle">Not in the decision log</span>
                        )}
                      </div>
                      <DecisionMenu decisionId={decision.id} />
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title="No decisions recorded" className="py-6" />
              )}
              <PanelBody className="border-t border-admin-row">
                <AddDecisionForm meetingId={meeting.id} />
              </PanelBody>
            </Panel>

            <Panel>
              <PanelHeader title="Action items" description={detail.actionItems.length ? `${open} open of ${detail.actionItems.length}` : undefined} />
              {detail.actionItems.length > 0 ? (
                <ActionItemList items={detail.actionItems.map((item) => actionItemView(item, now))} officers={pickers} showMeeting={false} showOwner />
              ) : (
                <EmptyState title="No action items" className="py-6" />
              )}
              <PanelBody className="border-t border-admin-row">
                <AddActionItemForm officers={pickers} meetingId={meeting.id} />
              </PanelBody>
            </Panel>
          </div>
        }
        side={
          <div className="flex flex-col gap-4">
            <MeetingForm
              // A fresh form after every change, so an edit is always made from what the page shows
              key={meeting.updatedAt.toISOString()}
              compact
              id={meeting.id}
              initial={{
                title: meeting.title,
                type: meeting.kind,
                date: formatInTimeZone(meeting.heldAt, DEFAULT_TIMEZONE, "yyyy-MM-dd"),
                time: meetingTimeInput(meeting.heldAt),
                agendaMd: meeting.agendaMd ?? "",
                summaryMd: meeting.summaryMd ?? "",
              }}
            />
            <Panel>
              <PanelHeader title="Details" />
              <PanelBody>
                <DetailList
                  items={[
                    {
                      label: "Recorded",
                      value: `${day(meeting.createdAt)}${detail.createdBy ? ` by ${detail.createdBy.displayName}` : ""}`,
                    },
                    ...(detail.transcript
                      ? [
                          {
                            label: "Transcript",
                            value: (
                              <span className="flex flex-col gap-0.5">
                                <a href={`/api/admin/jack/files/${detail.transcript.id}`} className="break-all font-medium hover:underline">
                                  {detail.transcript.filename}
                                </a>
                                <span className="text-xs text-admin-subtle">Attached in a Jack room</span>
                              </span>
                            ),
                          },
                        ]
                      : []),
                    ...(detail.transcriptDocument
                      ? [
                          {
                            label: "Transcript",
                            value: (
                              <span className="flex flex-col gap-0.5">
                                <DocumentLink name={detail.transcriptDocument.name} url={detail.transcriptDocument.webUrl} />
                                <span className="break-words text-xs text-admin-subtle">{transcriptSource(detail.transcriptDocument)}</span>
                              </span>
                            ),
                          },
                        ]
                      : []),
                    ...(detail.room
                      ? [
                          {
                            label: "From",
                            value: (
                              <Link href={roomMessagePath(detail.room.id)} className="font-medium hover:underline">
                                {detail.room.title ?? "A Jack room"}
                              </Link>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </PanelBody>
            </Panel>
          </div>
        }
      />
    </>
  )
}
