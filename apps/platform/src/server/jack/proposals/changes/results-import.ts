import { z } from "zod"
import { prisma } from "@/server/db"
import * as results from "@/server/services/results.service"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalKind, ProposalLink, ProposalPerson } from "../types"
import { roomFile, roomFileBytes } from "./room-file"
import { listed, plural, revalidate, when } from "./shared"

/**
 * results.import (design §4.3): race results from a sim results file (.json) an officer attached in the
 * room. Propose runs the results service's pure parse (previewResultFile: no DriverIdentity or upload
 * written) and shows what's in the file and which drivers aren't linked to a member. Apply runs the admin
 * Results page's four steps through the same service, as the applying officer: upload, parse, link to
 * the event, ingest. The file's sha256 is pinned (the framework checks the room file before applying, and
 * the bytes read here are checked against it).
 */

const SESSION_LABEL = { RACE: "race", QUALIFYING: "qualifying", PRACTICE: "practice" } as const
const POINTS_LABEL = { F1: "F1 points", HALF: "half points", NONE: "no points" } as const

export const resultsImportSchema = z.object({
  fileId: z.string().trim().min(1).max(64).describe("The attached results file's id (a .json the sim server saved)"),
  eventId: z.string().trim().min(1).max(64).describe("The event the session belongs to (Event.id), from events_overview"),
  sessionLabel: z.enum(["RACE", "QUALIFYING", "PRACTICE"]).describe("Which session the file is"),
  pointsSystem: z.enum(["F1", "HALF", "NONE"]).default("F1").describe("How a race awards points (practice and qualifying never do)"),
})

export type ResultsImport = z.infer<typeof resultsImportSchema>

/** AC writes the session type as RACE, QUALIFY or PRACTICE */
const FILE_SESSION: Record<string, string> = { RACE: "RACE", QUALIFY: "QUALIFYING", QUALIFYING: "QUALIFYING", PRACTICE: "PRACTICE" }

function fileFacts(raw: unknown): { track: string | null; session: string | null; startedAt: Date | null } {
  const file = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)
  const date = text(file.Date) ? new Date(file.Date as string) : null
  const type = text(file.Type)?.toUpperCase()
  return {
    track: [text(file.TrackName), text(file.TrackConfig)].filter(Boolean).join(" ") || null,
    session: type ? (FILE_SESSION[type] ?? null) : null,
    startedAt: date && !Number.isNaN(date.getTime()) ? date : null,
  }
}

/** An upload of this exact file (by sha256) that's already ingested, if any */
async function ingestedCopy(sha256: string) {
  return prisma.rawResultUpload.findFirst({
    where: { sha256, OR: [{ status: "INGESTED" }, { ingestedSessions: { some: {} } }] },
    select: { id: true, event: { select: { title: true } } },
  })
}

function effectivePoints(p: ResultsImport): keyof typeof POINTS_LABEL {
  return p.sessionLabel === "RACE" ? p.pointsSystem : "NONE"
}

const savedBefore = z.object({ eventTitle: z.string() })

export const resultsImportKind: ProposalKind<ResultsImport> = {
  kind: "results.import",
  tool: "propose_import",
  description:
    "results.import: import race results from a sim results file (.json) attached in this room into an event's session: it's uploaded, parsed, linked to the event and ingested, as on the Results page. Give the file's id, the event's id (events_overview), the session (RACE, QUALIFYING or PRACTICE) and, for a race, the points (F1 by default, HALF or NONE). The card shows the drivers and which aren't linked to a member yet. Standings aren't recomputed (that's on the season page).",
  schema: resultsImportSchema,
  targetType: "RESULT_UPLOAD",
  permission: "officer",

  async prepare(p, ctx) {
    const file = await roomFile(p.fileId, ctx.roomId, ["JSON"], "the results .json file the sim server saved")
    const event = await prisma.event.findUnique({ where: { id: p.eventId }, select: { id: true, title: true, startsAtUtc: true } })
    if (!event) throw new ProposalInputError(`There's no event with id ${p.eventId}. Find it with events_overview.`)

    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(await roomFileBytes(file, "propose")))
    } catch (error) {
      if (error instanceof ProposalInputError) throw error
      throw new ProposalInputError(`${file.filename} isn't valid JSON, so it isn't a results file.`)
    }
    const preview = await results.previewResultFile(raw)
    if (!preview.ok) throw new ProposalInputError(`${file.filename}: ${preview.error}`)
    const copy = await ingestedCopy(file.sha256)
    if (copy) throw new ProposalInputError(`This exact file is already imported${copy.event ? ` for “${copy.event.title}”` : ""} (/admin/results/${copy.id}). Importing it again would count the session twice.`)

    const facts = fileFacts(raw)
    const { report, unmatchedDrivers } = preview
    const sessions = await prisma.raceSession.count({ where: { eventId: event.id, sessionType: p.sessionLabel } })
    const unmatched = new Set(unmatchedDrivers.map((d) => d.guid))
    const linked = await prisma.driverIdentity.findMany({
      where: { driverGuid: { in: report.drivers.filter((d) => !unmatched.has(d.guid)).map((d) => d.guid) } },
      select: { driverGuid: true, user: { select: { displayName: true } } },
    })
    const memberOf = new Map(linked.map((identity) => [identity.driverGuid, identity.user?.displayName ?? null]))
    const people: ProposalPerson[] = report.drivers.map((driver) => ({
      name: driver.driverName || "Unknown driver",
      detail: unmatched.has(driver.guid) ? "not linked to a member" : (memberOf.get(driver.guid) ?? undefined),
    }))

    const label = SESSION_LABEL[p.sessionLabel]
    const points = effectivePoints(p)
    const fileSession = facts.session ? SESSION_LABEL[facts.session as keyof typeof SESSION_LABEL] : null
    const about = [facts.track, fileSession, facts.startedAt ? when(facts.startedAt) : null].filter(Boolean)
    const sentences = [
      `Applying it uploads ${file.filename}, links it to “${event.title}” as the ${label} with ${POINTS_LABEL[points]}, and creates the session's records: ${plural(report.drivers.length, "driver")}, ${plural(report.resultsCount, "result")}, ${plural(report.lapsCount, "lap")}.`,
      about.length ? `The file: ${about.join(", ")}.` : null,
      fileSession && facts.session !== p.sessionLabel ? `Heads up: the file says it's ${fileSession}, not ${label}.` : null,
      p.sessionLabel !== "RACE" && p.pointsSystem !== "NONE" ? `${label[0].toUpperCase()}${label.slice(1)} never awards points.` : null,
      unmatchedDrivers.length ? `${plural(unmatchedDrivers.length, "driver isn't", "drivers aren't")} linked to a member (${listed(unmatchedDrivers.slice(0, 5).map((d) => d.driverName))}${unmatchedDrivers.length > 5 ? " and more" : ""}), so their points don't count in standings until they're mapped on Driver mapping.` : null,
      report.anomalies.length ? `The parse found ${plural(report.anomalies.length, "problem")}: ${report.anomalies.slice(0, 3).join("; ")}.` : null,
      sessions ? `“${event.title}” already has ${plural(sessions, `${label} session`)} ingested; this adds another.` : null,
      "Standings aren't recomputed; do that on the season page.",
    ].filter(Boolean)

    const links: ProposalLink[] = [
      { title: "Results", url: "/admin/results" },
      { title: "Event", url: `/admin/events/${event.id}/edit` },
      ...(unmatchedDrivers.length ? [{ title: "Driver mapping", url: "/admin/drivers" }] : []),
    ]
    return {
      before: { eventTitle: event.title },
      targetId: `file:${file.id}`,
      fileSha256: file.sha256,
      view: { title: `Import ${label} results into “${event.title}”`, summary: sentences.join(" "), diff: [], people, links },
    }
  },

  async checkStale(p, before) {
    const saved = savedBefore.safeParse(before)
    if (!saved.success) return "The proposal's copy is missing. Ask Jack to propose it again."
    if (!(await prisma.event.findUnique({ where: { id: p.eventId }, select: { id: true } }))) return `The event “${saved.data.eventTitle}” was deleted.`
    const file = await prisma.jackFile.findUnique({ where: { id: p.fileId }, select: { sha256: true } })
    const copy = file?.sha256 ? await ingestedCopy(file.sha256) : null
    if (copy) return `This file was imported since this was proposed (/admin/results/${copy.id}).`
    return null
  },

  async apply(p, ctx) {
    const row = await prisma.jackFile.findUnique({ where: { id: p.fileId }, select: { id: true, filename: true, storagePath: true, sha256: true, roomId: true } })
    if (!row?.sha256 || row.roomId !== ctx.roomId) throw new StaleProposalError("The file it was built from was deleted.")
    const bytes = await roomFileBytes({ filename: row.filename, storagePath: row.storagePath, sha256: row.sha256 }, "apply")
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    const paths: string[] = []

    const upload = await results.createUpload({ filename: row.filename, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }, actor)
    if (!upload.ok) throw new Error(upload.error)
    paths.push(...upload.revalidate)
    const uploadId = upload.upload.id
    // From here the upload exists: a step that stops says where to finish or delete it
    const stopped = (step: string, error: string) => {
      revalidate(paths)
      return new Error(`${error.replace(/[.\s]*$/, ".")} The upload stopped at “${step}”: finish or delete it at /admin/results/${uploadId}.`)
    }
    const parsed = await results.parseUpload(uploadId, { write: true, actor })
    if (!parsed.ok) throw stopped("parse", parsed.error)
    paths.push(...parsed.revalidate)
    const bound = await results.bindUpload({ uploadId, eventId: p.eventId, pointsSystem: effectivePoints(p), sessionLabel: p.sessionLabel }, actor)
    if (!bound.ok) throw stopped("link the event", bound.error)
    paths.push(...bound.revalidate)
    const ingested = await results.ingestUpload(uploadId, actor)
    if (!ingested.ok) throw stopped("ingest", ingested.error)
    paths.push(...ingested.revalidate)
    revalidate(paths)

    const event = await prisma.event.findUnique({ where: { id: p.eventId }, select: { title: true, slug: true } })
    const { counts } = ingested
    return {
      summary: `Imported the ${SESSION_LABEL[p.sessionLabel]} results into “${event?.title ?? "the event"}”: ${plural(counts.results, "result")}, ${plural(counts.laps, "lap")}.`,
      links: [{ title: "Upload", url: `/admin/results/${uploadId}` }, ...(event ? [{ title: "Event page", url: `/events/${event.slug}` }] : [])],
      created: [
        { type: "RESULT_UPLOAD", id: uploadId },
        { type: "RACE_SESSION", id: ingested.session.id },
      ],
      counts,
    }
  },
}
