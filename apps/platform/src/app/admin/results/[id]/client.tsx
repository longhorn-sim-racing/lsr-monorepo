"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { formatInTimeZone } from "date-fns-tz"
import { Download, Loader2 } from "lucide-react"
import type { RawResultUploadStatus } from "@prisma/client"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { unexpectedError } from "@/lib/action-result"
import {
  Badge,
  Button,
  DetailList,
  Field,
  FieldGrid,
  FormActions,
  Notice,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  SplitLayout,
  Table,
  TD,
  TH,
  THead,
  ToneText,
  TR,
  useConfirm,
} from "@/components/admin/kit"
import { bindEventToUpload, deleteUpload, ingestUpload, previewParseResult } from "@/app/admin/results/actions"
import { POINTS_LABEL, SESSION_LABEL, STATUS_LABEL, STATUS_TONE, formatBytes } from "../_components/result-labels"
import { StepPanel, type StepState } from "../_components/step-panel"

/** Facts read from the uploaded JSON on the server */
export type FileSummary = {
  track: string | null
  trackConfig: string | null
  startedAt: Date | null
  /** PRACTICE, QUALIFYING or RACE, when the file says */
  sessionType: string | null
  cars: number | null
}

export type ParsedDriverRow = { guid: string; driverName: string; carModel: string; member: { displayName: string; handle: string } | null }

type UploadView = {
  id: string
  filename: string
  filesize: number
  sha256: string
  status: RawResultUploadStatus
  errorMessage: string | null
  uploadedAt: Date
  uploadedBy: string
  eventId: string | null
  eventTitle: string | null
  sessionLabel: string | null
  pointsSystem: string | null
  ingestedSessions: number
  report: { resultsCount: number; lapsCount: number; anomalies: string[] } | null
}

type EventOption = { id: string; title: string; startsAtUtc: Date }

type Busy = null | "parse" | "save" | "ingest" | "delete"

const central = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ResultDetailClient({
  upload,
  file,
  drivers,
  events,
  suggestedEventId,
}: {
  upload: UploadView
  file: FileSummary
  drivers: ParsedDriverRow[]
  events: EventOption[]
  suggestedEventId: string | null
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<Busy>(null)

  // The event link form. A new upload starts on the event from the same day and the session type the file states.
  const [eventId, setEventId] = useState(upload.eventId ?? suggestedEventId ?? "")
  const [session, setSession] = useState(upload.sessionLabel ?? file.sessionType ?? "RACE")
  const [points, setPoints] = useState(upload.pointsSystem ?? "F1")

  // Older uploads could be re-parsed after ingesting, which reset the status; their race sessions still count
  const ingested = upload.status === "INGESTED" || upload.ingestedSessions > 0
  const parsed = !!upload.report
  const linked = !!upload.eventId
  const nonRace = session === "PRACTICE" || session === "QUALIFYING"
  // Practice and qualifying never award points (bindEventToUpload enforces it too)
  const effectivePoints = nonRace ? "NONE" : points
  const dirty = eventId !== (upload.eventId ?? "") || session !== (upload.sessionLabel ?? "RACE") || effectivePoints !== (upload.pointsSystem ?? "F1")
  const readyToIngest = parsed && linked && !dirty && !ingested

  const parseState: StepState = parsed || ingested ? "done" : "current"
  const linkState: StepState = ingested || (linked && !dirty) ? "done" : parsed ? "current" : "todo"
  const ingestState: StepState = ingested ? "done" : readyToIngest ? "current" : "todo"

  const unmapped = drivers.filter((driver) => !driver.member).length
  const anomalies = upload.report?.anomalies ?? []

  async function parse() {
    setBusy("parse")
    try {
      const result = await previewParseResult(upload.id)
      if (!result.ok) toast.error(result.error)
      else if (result.data.status === "FAILED") toast.warning("Parsed, with problems", { description: "See the problems listed under step 1." })
      else toast.success("File parsed")
      router.refresh()
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't parse the file"))
    } finally {
      setBusy(null)
    }
  }

  async function saveLink() {
    if (!eventId) return
    setBusy("save")
    try {
      const result = await bindEventToUpload(upload.id, eventId, effectivePoints, session)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("Event link saved")
      router.refresh()
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't save the event link"))
    } finally {
      setBusy(null)
    }
  }

  async function ingest() {
    const ok = await confirm({
      title: "Ingest these results?",
      description: `Creates the official race records for ${upload.eventTitle ?? "the linked event"} (${SESSION_LABEL[session] ?? session}, ${
        POINTS_LABEL[effectivePoints] ?? effectivePoints
      }). They show on the site right away.`,
      confirmLabel: "Ingest",
    })
    if (!ok) return
    setBusy("ingest")
    try {
      const result = await ingestUpload(upload.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("Results ingested", {
        description: "Recompute the season's standings to update points.",
        action: { label: "Seasons", onClick: () => router.push("/admin/seasons") },
      })
      router.refresh()
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't ingest the results"))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    const ok = await confirm(
      ingested
        ? {
            title: "Delete these results and their race records?",
            description:
              "Deletes the upload and the race session, results, laps and incidents ingested from it. Standings keep their numbers until you recompute the season. This can't be undone.",
            confirmLabel: "Delete everything",
            tone: "danger",
          }
        : {
            title: `Delete ${upload.filename}?`,
            description: "Deletes the uploaded file and its parse report. This can't be undone.",
            tone: "danger",
          },
    )
    if (!ok) return
    setBusy("delete")
    try {
      const result = await deleteUpload(upload.id, ingested)
      if (!result.ok) {
        toast.error(result.error)
        setBusy(null)
        return
      }
      toast.success(`Deleted ${upload.filename}`)
      router.push("/admin/results")
    } catch (error) {
      console.error(error)
      toast.error(unexpectedError(error, "Couldn't delete the upload"))
      setBusy(null)
    }
  }

  const ingestBlocker = !parsed
    ? "Parse the file first."
    : !linked
      ? "Link it to an event and save first."
      : dirty
        ? "Save your changes to the event link first."
        : null

  return (
    <>
      <PageHeader
        title={<span className="break-all">{upload.filename}</span>}
        back={{ href: "/admin/results", label: "Results" }}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[upload.status]}>{STATUS_LABEL[upload.status]}</Badge>
            Uploaded by {upload.uploadedBy}, {central(upload.uploadedAt, "MMM d, yyyy, h:mm a")} CT
          </span>
        }
        actions={
          <>
            <Button asChild>
              <a href={`/admin/results/${upload.id}/raw`} download={upload.filename}>
                <Download aria-hidden />
                Download JSON
              </a>
            </Button>
            <Button variant="danger" onClick={remove} pending={busy === "delete"} disabled={busy !== null && busy !== "delete"}>
              {ingested ? "Delete with race records" : "Delete"}
            </Button>
          </>
        }
      />

      <SplitLayout
        main={
          <div className="flex flex-col gap-4">
            <StepPanel
              step={1}
              title="Parse the file"
              description="Reads the drivers, results and laps, and records any driver GUIDs the site hasn't seen."
              state={parseState}
              footer={
                <FormActions className="w-full" note={ingested ? "Ingested files can't be parsed again." : undefined}>
                  <Button variant={parseState === "current" ? "primary" : "secondary"} onClick={parse} pending={busy === "parse"} disabled={ingested || (busy !== null && busy !== "parse")}>
                    {parsed ? "Parse again" : "Parse file"}
                  </Button>
                </FormActions>
              }
            >
              {upload.report ? (
                <div className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "Results", value: upload.report.resultsCount },
                      { label: "Laps", value: upload.report.lapsCount },
                      { label: "Drivers", value: drivers.length },
                      { label: "Not mapped", value: unmapped },
                    ].map((item) => (
                      <div key={item.label} className="flex flex-col gap-0.5 rounded-md bg-admin-surface px-3 py-2">
                        <dt className="text-xs text-muted-foreground">{item.label}</dt>
                        <dd className="text-base font-semibold tabular-nums">{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {anomalies.length > 0 && (
                    <Notice tone="danger" title={`${plural(anomalies.length, "problem")} found in the file`}>
                      <ul className="list-disc pl-4">
                        {anomalies.map((anomaly, i) => (
                          <li key={i}>{anomaly}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">Not parsed yet.</p>
              )}
            </StepPanel>

            <StepPanel
              step={2}
              title="Link it to an event"
              description="Which event and session these results belong to, and how points are awarded."
              state={linkState}
              footer={
                <FormActions
                  className="w-full"
                  note={ingested ? "Ingested results can't be relinked. Delete them with their race records to redo." : dirty ? "Unsaved changes" : linked ? "Saved" : undefined}
                >
                  <Button
                    variant={linkState === "current" ? "primary" : "secondary"}
                    onClick={saveLink}
                    pending={busy === "save"}
                    disabled={ingested || !dirty || !eventId || (busy !== null && busy !== "save")}
                  >
                    Save event link
                  </Button>
                </FormActions>
              }
            >
              <FieldGrid>
                <Field
                  label="Event"
                  htmlFor="result-event"
                  className="sm:col-span-2"
                  hint={
                    !upload.eventId && suggestedEventId && eventId === suggestedEventId
                      ? "Suggested: it's on the same day as the session in the file."
                      : file.startedAt
                        ? `The session in the file started ${central(file.startedAt, "MMM d, yyyy, h:mm a")} CT.`
                        : "Showing the 50 most recent events."
                  }
                >
                  <Select id="result-event" value={eventId} onChange={(e) => setEventId(e.target.value)} disabled={ingested || busy !== null}>
                    <option value="">Choose an event</option>
                    {events.map((event) => (
                      <option key={event.id} value={event.id}>
                        {central(event.startsAtUtc, "MMM d, yyyy")} · {event.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Session" htmlFor="result-session">
                  <Select id="result-session" value={session} onChange={(e) => setSession(e.target.value)} disabled={ingested || busy !== null}>
                    <option value="PRACTICE">Practice</option>
                    <option value="QUALIFYING">Qualifying</option>
                    <option value="RACE">Race</option>
                  </Select>
                </Field>
                <Field label="Points" htmlFor="result-points" hint={nonRace ? "Practice and qualifying never award points." : undefined}>
                  <Select id="result-points" value={effectivePoints} onChange={(e) => setPoints(e.target.value)} disabled={ingested || nonRace || busy !== null}>
                    <option value="F1">F1 (25, 18, 15…)</option>
                    <option value="HALF">Half points</option>
                    <option value="NONE">No points</option>
                  </Select>
                </Field>
              </FieldGrid>
            </StepPanel>

            <StepPanel
              step={3}
              title="Ingest"
              description="Creates the official race session, results, laps and incident records. Ingest each file once."
              state={ingestState}
              footer={
                !ingested && (
                  <FormActions className="w-full" note={busy === "ingest" ? undefined : ingestBlocker}>
                    <Button variant={readyToIngest ? "primary" : "secondary"} onClick={ingest} pending={busy === "ingest"} disabled={!readyToIngest || (busy !== null && busy !== "ingest")}>
                      Ingest results
                    </Button>
                  </FormActions>
                )
              }
            >
              {ingested ? (
                <Notice tone="success" title={`Ingested into ${upload.eventTitle ?? "its event"}`}>
                  {plural(upload.ingestedSessions, "race session")} created.{" "}
                  <Link href="/admin/seasons" className="font-medium text-foreground hover:underline">
                    Recompute the season&apos;s standings
                  </Link>{" "}
                  to update points.
                </Notice>
              ) : busy === "ingest" ? (
                <Notice tone="info" title="Ingesting results">
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                    Creating the race records. This can take up to 20 seconds; keep this page open.
                  </span>
                </Notice>
              ) : readyToIngest ? (
                <p className="text-[13px] text-muted-foreground">
                  Ready: {upload.eventTitle} · {SESSION_LABEL[session] ?? session} · {POINTS_LABEL[effectivePoints] ?? effectivePoints}.
                  {unmapped > 0 &&
                    ` ${unmapped === 1 ? "1 driver isn't" : `${unmapped} drivers aren't`} mapped to a member yet, so their results won't count for anyone until you map them.`}
                </p>
              ) : undefined}
            </StepPanel>

            {drivers.length > 0 && (
              <Panel>
                <PanelHeader
                  title="Drivers in the file"
                  description={`${plural(drivers.length, "driver")}${unmapped ? ` · ${unmapped} not mapped to a member` : " · all mapped to members"}`}
                  actions={
                    <Button size="sm" variant="ghost" asChild>
                      <Link href="/admin/drivers">Driver mapping</Link>
                    </Button>
                  }
                />
                <Table minWidth={560} className="rounded-none border-0">
                  <THead>
                    <TH>Driver</TH>
                    <TH>Member</TH>
                    <TH>Car</TH>
                    <TH>GUID</TH>
                  </THead>
                  <tbody>
                    {drivers.map((driver) => (
                      <TR key={driver.guid}>
                        <TD className="font-medium">{driver.driverName}</TD>
                        <TD>
                          {driver.member ? (
                            <span>
                              {driver.member.displayName} <span className="text-admin-subtle">@{driver.member.handle}</span>
                            </span>
                          ) : (
                            <ToneText tone="warning">Not mapped</ToneText>
                          )}
                        </TD>
                        <TD className="text-muted-foreground">{driver.carModel}</TD>
                        <TD className="font-mono text-xs text-admin-subtle">{driver.guid}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Panel>
            )}
          </div>
        }
        side={
          <Panel>
            <PanelHeader title="File" />
            <PanelBody className="flex flex-col gap-3">
              <DetailList
                items={[
                  { label: "Track", value: file.track ? `${file.track}${file.trackConfig ? ` (${file.trackConfig})` : ""}` : "Not stated" },
                  { label: "Session", value: file.sessionType ? SESSION_LABEL[file.sessionType] : "Not stated" },
                  { label: "Started", value: file.startedAt ? `${central(file.startedAt, "MMM d, yyyy, h:mm a")} CT` : "Not stated" },
                  { label: "Cars", value: file.cars ?? "Not stated" },
                  { label: "Size", value: formatBytes(upload.filesize) },
                  { label: "SHA-256", value: <span className="break-all font-mono text-xs text-admin-subtle">{upload.sha256}</span> },
                  { label: "Upload ID", value: <span className="break-all font-mono text-xs text-admin-subtle">{upload.id}</span> },
                ]}
              />
              {upload.errorMessage && !upload.report && (
                <Notice tone="danger" title="Last error">
                  {upload.errorMessage}
                </Notice>
              )}
            </PanelBody>
          </Panel>
        }
      />
    </>
  )
}
