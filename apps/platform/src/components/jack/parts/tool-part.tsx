"use client"

import { memo, useState } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { ArrowRight, CalendarPlus, CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react"
import { Badge, Button, JsonView, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import type { JackCellValue, JackToolDisplay, JackToolPart } from "@/lib/jack/parts"
import { cn } from "@/lib/utils"
import { DeckCard } from "./deck-card"

/* recharts is heavy; load it only when a reply has a chart */
const ChartView = dynamic(() => import("./chart-view").then((m) => m.ChartView), {
  ssr: false,
  loading: () => <div className="h-[300px] animate-pulse rounded-md bg-admin-surface" />,
})

const TZ = "America/Chicago"
const PREVIEW_ROWS = 10

/**
 * One tool call inside a reply: a header line with its status, label and time; collapsed details with
 * the input and any SQL; then what it shows (a table, a chart, an event draft, a note). Memoized: a part
 * keeps its object until it changes, so text streaming into the reply doesn't redraw its tables and charts.
 */
export const JackToolPartView = memo(function JackToolPartView({ part }: { part: JackToolPart }) {
  const displays = Array.isArray(part.displays) ? part.displays : []
  const sql = displays.filter((d): d is Extract<JackToolDisplay, { kind: "sql" }> => d.kind === "sql")
  const shown = displays.filter((d) => d.kind !== "sql")

  return (
    <div className="w-full min-w-0 max-w-3xl overflow-hidden rounded-lg border bg-card text-[13px]">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 outline-none hover:bg-admin-surface focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          <StatusIcon status={part.status} />
          <span className="min-w-0 flex-1 break-words font-medium">
            {part.label}
            {part.status === "running" && "…"}
          </span>
          {typeof part.ms === "number" && <span className="shrink-0 text-xs tabular-nums text-admin-subtle">{formatMs(part.ms)}</span>}
          <ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-admin-subtle transition-transform group-open:rotate-90" />
        </summary>
        <div className="flex flex-col gap-2.5 border-t border-admin-row bg-admin-surface px-3 py-2.5">
          {sql.map((display, i) => (
            <SqlBlock key={i} display={display} />
          ))}
          {/* run_sql's input is the SQL above; other tools show what Jack asked for */}
          {!sql.length && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-admin-subtle">Input</span>
              <JsonView value={part.input ?? {}} className="max-h-48 bg-card" />
            </div>
          )}
        </div>
      </details>

      {part.status === "error" && (
        <p role="alert" className="break-words border-t border-tone-danger-foreground/20 bg-tone-danger px-3 py-2 text-tone-danger-foreground">
          {part.error || "This step failed."}
        </p>
      )}

      {shown.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-admin-row p-3">
          {shown.map((display, i) => (
            <DisplayView key={i} display={display} />
          ))}
        </div>
      )}
    </div>
  )
})

function StatusIcon({ status }: { status: JackToolPart["status"] }) {
  if (status === "running") return <Loader2 aria-label="Running" className="mt-0.5 size-3.5 shrink-0 animate-spin text-admin-subtle" />
  if (status === "error") return <XCircle aria-label="Failed" className="mt-0.5 size-3.5 shrink-0 text-tone-danger-foreground" />
  return <CheckCircle2 aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-tone-success-foreground" />
}

function DisplayView({ display }: { display: JackToolDisplay }) {
  switch (display.kind) {
    case "table":
      return <TableView display={display} />
    case "chart":
      return <ChartView chart={display.chart} />
    case "event_draft":
      return <EventDraftCard display={display} />
    case "note":
      return <p className="whitespace-pre-wrap break-words text-muted-foreground">{display.text}</p>
    case "sql":
      return <SqlBlock display={display} />
    case "deck":
      return <DeckCard display={display} />
    default:
      return null
  }
}

function SqlBlock({ display }: { display: Extract<JackToolDisplay, { kind: "sql" }> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-admin-subtle">
        SQL · {display.rowCount === 1 ? "1 row" : `${display.rowCount}${display.truncated ? "+" : ""} rows`} · {formatMs(display.ms)}
        {display.truncated && " · capped"}
      </span>
      <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border bg-card p-2.5 font-mono text-xs leading-relaxed text-foreground">{display.sql}</pre>
    </div>
  )
}

/* Tables */

function TableView({ display }: { display: Extract<JackToolDisplay, { kind: "table" }> }) {
  const [all, setAll] = useState(false)
  const rows = all ? display.rows : display.rows.slice(0, PREVIEW_ROWS)
  const numeric = display.columns.map((_, i) => display.rows.some((row) => typeof row[i] === "number") && display.rows.every((row) => row[i] === null || typeof row[i] === "number"))

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Table minWidth={Math.min(640, Math.max(280, display.columns.length * 110))} className="max-h-[420px] overflow-y-auto">
        <THead>
          {display.columns.map((column, i) => (
            <TH key={i} className={cn(numeric[i] && "text-right")}>
              {column}
            </TH>
          ))}
        </THead>
        <tbody>
          {rows.map((row, r) => (
            <TR key={r}>
              {row.map((cell, i) => (
                <TD key={i} className={cn("py-1.5", numeric[i] && "text-right tabular-nums")}>
                  <Cell value={cell} />
                </TD>
              ))}
            </TR>
          ))}
        </tbody>
      </Table>
      {(display.caption || display.rows.length > PREVIEW_ROWS) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-admin-subtle">
          {display.caption && <span>{display.caption}</span>}
          {display.rows.length > PREVIEW_ROWS && (
            <button type="button" onClick={() => setAll((v) => !v)} className="font-medium text-foreground underline-offset-2 hover:underline">
              {all ? "Show fewer" : `Show all ${display.rows.length} rows`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/
const centralDateTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })

/** Times from the database are UTC; officers read them in Central time */
function Cell({ value }: { value: JackCellValue }) {
  if (value === null) return <span className="text-admin-subtle">—</span>
  if (typeof value === "boolean") return <>{value ? "yes" : "no"}</>
  if (typeof value === "number") return <span className="whitespace-nowrap">{value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: Math.abs(value) >= 10_000 })}</span>
  if (ISO_UTC.test(value)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return (
        <span className="whitespace-nowrap" title={value}>
          {centralDateTime.format(date)} CT
        </span>
      )
  }
  return (
    <span className="block max-w-[280px] truncate" title={value.length > 40 ? value : undefined}>
      {value}
    </span>
  )
}

/* Event drafts */

const dayTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const timeOnly = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })

function formatEventWindow(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (Number.isNaN(start.getTime())) return "Time not set"
  if (Number.isNaN(end.getTime())) return `${dayTime.format(start)} CT`
  const sameDay = dayKey.format(start) === dayKey.format(end)
  return `${dayTime.format(start)} – ${sameDay ? timeOnly.format(end) : dayTime.format(end)} CT`
}

function EventDraftCard({ display }: { display: Extract<JackToolDisplay, { kind: "event_draft" }> }) {
  // Only ever a link inside the admin console
  const href = display.editUrl.startsWith("/admin/") ? display.editUrl : null
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-admin-surface p-3 sm:flex-row sm:items-center">
      <CalendarPlus aria-hidden className="hidden size-4 shrink-0 text-admin-subtle sm:block" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words font-semibold">{display.title}</span>
          <Badge tone="neutral">Draft</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatEventWindow(display.startsAt, display.endsAt)} · {display.venue ?? "No venue yet"}
        </p>
        <p className="text-xs text-admin-subtle">Hidden from members until an officer publishes it.</p>
      </div>
      {href && (
        <Button asChild size="sm" className="self-start sm:self-center">
          <Link href={href}>
            Open in Events
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      )}
    </div>
  )
}

function formatMs(ms: number) {
  return ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`
}
