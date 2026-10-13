"use client"

import { useState } from "react"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { ChevronRight, Download, Upload } from "lucide-react"
import type { RawResultUploadStatus } from "@prisma/client"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { Badge, Button, CellStack, DataTable, EmptyState, IconButton, PageHeader, RowActions, Segmented, ToneText, type Column } from "@/components/admin/kit"
import { POINTS_LABEL, SESSION_LABEL, STATUS_LABEL, STATUS_TONE, formatBytes } from "./_components/result-labels"
import { UploadDialog } from "./_components/upload-dialog"

export type ResultRow = {
  id: string
  filename: string
  filesize: number
  status: RawResultUploadStatus
  uploadedAt: Date
  sessionLabel: string | null
  pointsSystem: string | null
  uploadedBy: { displayName: string }
  event: { id: string; title: string } | null
}

type View = "all" | "open" | "ingested" | "failed"

const central = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIMEZONE, pattern)

const columns: Column<ResultRow>[] = [
  {
    id: "file",
    header: "File",
    sortValue: (r) => r.filename,
    cell: (r) => (
      <CellStack
        primary={
          <Link href={`/admin/results/${r.id}`} className="hover:underline">
            {r.filename}
          </Link>
        }
        secondary={`${r.uploadedBy.displayName} · ${formatBytes(r.filesize)}`}
      />
    ),
  },
  {
    id: "uploadedAt",
    header: "Uploaded",
    sortValue: (r) => r.uploadedAt,
    className: "whitespace-nowrap",
    cell: (r) => <span className="text-muted-foreground">{central(r.uploadedAt, "MMM d, h:mm a")}</span>,
  },
  {
    id: "event",
    header: "Event",
    sortValue: (r) => r.event?.title,
    cell: (r) =>
      r.event ? (
        <CellStack
          primary={<span className="font-medium">{r.event.title}</span>}
          secondary={[r.sessionLabel && SESSION_LABEL[r.sessionLabel], r.pointsSystem && POINTS_LABEL[r.pointsSystem]].filter(Boolean).join(" · ") || undefined}
        />
      ) : (
        <ToneText tone="warning">Not linked</ToneText>
      ),
  },
  { id: "status", header: "Status", sortValue: (r) => r.status, cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
]

/** Drops ?upload=1 from the address bar once the dialog it opened is closed */
function clearUploadParam() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has("upload")) return
  url.searchParams.delete("upload")
  window.history.replaceState(window.history.state, "", url)
}

export function ResultsAdminClient({ results, openUpload = false }: { results: ResultRow[]; openUpload?: boolean }) {
  const [uploadOpen, setUploadOpen] = useState(openUpload)
  const [view, setView] = useState<View>("all")

  const counts = {
    all: results.length,
    open: results.filter((r) => r.status !== "INGESTED").length,
    ingested: results.filter((r) => r.status === "INGESTED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
  }
  const rows = results.filter((r) =>
    view === "all" ? true : view === "open" ? r.status !== "INGESTED" : view === "ingested" ? r.status === "INGESTED" : r.status === "FAILED",
  )

  const uploadButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} onClick={() => setUploadOpen(true)}>
      <Upload aria-hidden />
      Upload results
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Results"
        description="Race server result files. Parse each one, link it to an event, then ingest it into the standings."
        actions={uploadButton("primary")}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        search={{ placeholder: "Search files and events", text: (r) => `${r.filename} ${r.event?.title ?? ""} ${r.uploadedBy.displayName} ${STATUS_LABEL[r.status]}` }}
        filters={
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "open", label: "Not ingested", count: counts.open },
              { value: "ingested", label: "Ingested", count: counts.ingested },
              { value: "failed", label: "Failed", count: counts.failed },
            ]}
          />
        }
        initialSort={{ id: "uploadedAt", desc: true }}
        rowHref={(r) => `/admin/results/${r.id}`}
        noun={{ one: "upload", many: "uploads" }}
        minWidth={720}
        empty={
          results.length === 0 ? (
            <EmptyState title="No results uploaded" description="Upload a results .json file from the race server to add one." action={uploadButton("secondary")} />
          ) : (
            <EmptyState title="Nothing here" description="No uploads have this status." />
          )
        }
        rowActions={(r) => (
          <RowActions>
            <IconButton label={`Download ${r.filename}`} asChild>
              <a href={`/admin/results/${r.id}/raw`} download={r.filename}>
                <Download />
              </a>
            </IconButton>
            <IconButton label={`Open ${r.filename}`} asChild>
              <Link href={`/admin/results/${r.id}`}>
                <ChevronRight />
              </Link>
            </IconButton>
          </RowActions>
        )}
      />

      <UploadDialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open) clearUploadParam()
        }}
      />
    </>
  )
}
