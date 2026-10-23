import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { EmptyState, PageHeader, Panel, PanelBody } from "@/components/admin/kit"
import { agendaText, formatMeetingTime, meetingPath } from "@/lib/meetings"
import { requireOfficerPage } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import { MarkdownText } from "../../_components/markdown-text"
import { CopyAgendaButton } from "../../_components/meeting-parts"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Agenda" }

/**
 * A meeting's agenda, clean to paste (#188, design §13): the title, the time and the agenda on their
 * own, so selecting the panel and pasting into an email or a Teams post keeps the lists. "Copy as text"
 * copies the same as plain text
 */
export default async function AgendaPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, title: true, heldAt: true, agendaMd: true } })
  if (!meeting) notFound()

  return (
    <>
      <PageHeader
        back={{ href: meetingPath(meeting.id), label: meeting.title }}
        title="Agenda"
        description="Select the agenda below and paste it, or copy it as plain text."
        actions={meeting.agendaMd ? <CopyAgendaButton text={agendaText(meeting)} /> : undefined}
      />
      <Panel className="max-w-3xl">
        {meeting.agendaMd ? (
          <PanelBody className="flex flex-col gap-3 px-6 py-5 text-[14px]">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg font-semibold">{meeting.title}</h2>
              <p className="text-muted-foreground">{formatMeetingTime(meeting.heldAt)}</p>
            </div>
            <MarkdownText text={meeting.agendaMd} />
          </PanelBody>
        ) : (
          <EmptyState title="No agenda yet" description="Add one on the meeting's page, or ask Jack to draft one." />
        )}
      </Panel>
    </>
  )
}
