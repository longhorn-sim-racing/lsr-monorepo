import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { ResultDetailClient, type FileSummary, type ParsedDriverRow } from "./client"

export const metadata: Metadata = { title: "Result upload" }

/** One row of parseReport.drivers, as previewParseResult writes it */
type ParsedDriver = { guid: string; driverName: string; carModel: string }

/** AC writes the session type as RACE, QUALIFY or PRACTICE; the upload form uses these labels */
const FILE_SESSION: Record<string, string> = { RACE: "RACE", QUALIFY: "QUALIFYING", QUALIFYING: "QUALIFYING", PRACTICE: "PRACTICE" }

/** The few facts about the file the page shows, read from its JSON on the server so the JSON itself stays here */
function summarizeFile(rawJson: unknown): FileSummary {
  const file = (typeof rawJson === "object" && rawJson !== null ? rawJson : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)
  const count = (value: unknown) => (Array.isArray(value) ? value.length : null)
  const date = text(file.Date) ? new Date(file.Date as string) : null
  const type = text(file.Type)?.toUpperCase() ?? null
  return {
    track: text(file.TrackName),
    trackConfig: text(file.TrackConfig),
    startedAt: date && !Number.isNaN(date.getTime()) ? date : null,
    sessionType: type ? (FILE_SESSION[type] ?? null) : null,
    cars: count(file.Cars),
  }
}

const centralDay = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "yyyy-MM-dd")

export default async function ResultDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const result = await prisma.rawResultUpload.findUnique({
    where: { id },
    include: {
      uploadedBy: { select: { displayName: true } },
      parseReport: true,
      event: { select: { id: true, title: true, startsAtUtc: true } },
      _count: { select: { ingestedSessions: true } },
    },
  })
  if (!result) notFound()

  const { rawJson, ...upload } = result
  const file = summarizeFile(rawJson)

  const events = await prisma.event.findMany({
    orderBy: { startsAtUtc: "desc" },
    take: 50,
    select: { id: true, title: true, startsAtUtc: true },
  })
  // Keep the linked event selectable even when it's older than the 50 most recent
  if (upload.event && !events.some((event) => event.id === upload.event!.id)) events.push(upload.event)

  // An event on the same Central day as the session in the file is probably the right one
  const suggestedEventId = file.startedAt ? (events.find((event) => centralDay(event.startsAtUtc) === centralDay(file.startedAt!))?.id ?? null) : null

  // Which parsed drivers are mapped to members (unmapped ones won't count in standings)
  const parsed = (upload.parseReport?.drivers as ParsedDriver[] | null) ?? []
  const identities = parsed.length
    ? await prisma.driverIdentity.findMany({
        where: { driverGuid: { in: parsed.map((driver) => driver.guid) } },
        select: { driverGuid: true, user: { select: { displayName: true, handle: true } } },
      })
    : []
  const drivers: ParsedDriverRow[] = parsed.map((driver) => ({
    ...driver,
    member: identities.find((identity) => identity.driverGuid === driver.guid)?.user ?? null,
  }))

  return (
    <ResultDetailClient
      upload={{
        id: upload.id,
        filename: upload.filename,
        filesize: upload.filesize,
        sha256: upload.sha256,
        status: upload.status,
        errorMessage: upload.errorMessage,
        uploadedAt: upload.uploadedAt,
        uploadedBy: upload.uploadedBy.displayName,
        eventId: upload.eventId,
        eventTitle: upload.event?.title ?? null,
        sessionLabel: upload.sessionLabel,
        pointsSystem: upload.pointsSystem,
        ingestedSessions: upload._count.ingestedSessions,
        report: upload.parseReport
          ? { resultsCount: upload.parseReport.resultsCount, lapsCount: upload.parseReport.lapsCount, anomalies: upload.parseReport.anomalies }
          : null,
      }}
      file={file}
      drivers={drivers}
      events={events}
      suggestedEventId={suggestedEventId}
    />
  )
}
