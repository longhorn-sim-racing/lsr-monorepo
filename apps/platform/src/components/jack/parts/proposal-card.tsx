"use client"

import { useEffect, useState } from "react"
import { ArrowRight, FilePen, Loader2, RotateCw } from "lucide-react"
import { Badge, Button, DetailList, Notice, useConfirm } from "@/components/admin/kit"
import type { DiffHunkLine } from "@/lib/jack/line-diff"
import type { JackProposalDisplay } from "@/lib/jack/parts"
import {
  latestProposalState,
  PROPOSAL_STATUS,
  proposalApiUrl,
  type JackProposalDetail,
  type JackProposalDiffRow,
  type JackProposalRow,
} from "@/lib/jack/proposals"
import type { JackProposalState, JackProposalStatusKey } from "@/lib/jack/types"
import { cn } from "@/lib/utils"
import { MarkdownPreview } from "./markdown-preview"
import { PartLink } from "./part-link"
import { useProposalRoom } from "./proposal-context"

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })

/**
 * A change Jack proposed (#188, design §4.1). The reply's display is only the first few fields; the card
 * loads the whole proposal from the officer route (the diff, with long text as a line diff, people,
 * links, rows) and follows its live status from the room (snapshots and proposal.updated events), so the
 * reply's saved tool calls never change. In a room it offers Apply (confirming first when the kind can't
 * be taken back) and Discard; a proposal with rows gets a checkbox per row. After, it shows the outcome.
 */
export function ProposalCard({ display }: { display: JackProposalDisplay }) {
  const room = useProposalRoom()
  const id = display.proposalId
  const [detail, setDetail] = useState<JackProposalDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loads, setLoads] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch(proposalApiUrl(id), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "This proposal doesn't exist anymore." : response.status === 403 ? "Only officers can see this proposal." : "Couldn't load the whole change.")
        setDetail((await response.json()) as JackProposalDetail)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Couldn't load the whole change.")
      })
    return () => controller.abort()
  }, [id, loads])

  const live = room?.states[id]
  const fromDetail: JackProposalState | null = detail ? { status: detail.status, ...(detail.result ? { result: detail.result } : {}), updatedAt: detail.updatedAt } : null
  const state = latestProposalState(live, fromDetail)

  // Someone else applied or discarded it: load it again (once per change) for who did it and what came
  // of it. Adjusting state while rendering, React's pattern for reacting to a prop
  const [reloadedFor, setReloadedFor] = useState<string | null>(null)
  if (live && detail && live.status !== detail.status && live.updatedAt > detail.updatedAt && reloadedFor !== live.updatedAt) {
    setReloadedFor(live.updatedAt)
    setLoads((n) => n + 1)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-admin-surface p-3">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        <FilePen aria-hidden className="mt-0.5 size-4 shrink-0 text-admin-subtle" />
        <span className="min-w-0 flex-1 break-words font-semibold">{detail?.title ?? display.title}</span>
        <StatusBadge status={state?.status ?? null} />
      </div>
      {(detail?.summary ?? display.summary) && <p className="break-words text-muted-foreground">{detail?.summary ?? display.summary}</p>}

      {detail ? <FullChange detail={detail} /> : <Preview display={display} />}
      {loadError && !detail && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-tone-danger-foreground" role="alert">
          {loadError}
          <button type="button" onClick={() => setLoads((n) => n + 1)} className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
            <RotateCw aria-hidden className="size-3" />
            Try again
          </button>
        </p>
      )}

      {detail && <Footer detail={detail} state={state} onChanged={() => setLoads((n) => n + 1)} />}
    </div>
  )
}

function StatusBadge({ status }: { status: JackProposalStatusKey | null }) {
  if (!status) return <Badge>Proposed</Badge>
  const { label, tone } = PROPOSAL_STATUS[status]
  return (
    <Badge tone={tone}>
      {status === "APPLYING" && <Loader2 aria-hidden className="size-3 animate-spin" />}
      {label}
    </Badge>
  )
}

/** What the reply carried, while the full change loads (or if it can't) */
function Preview({ display }: { display: JackProposalDisplay }) {
  const counts = Object.entries(display.counts ?? {})
  return (
    <>
      {display.preview.length > 0 && (
        <DetailList
          items={display.preview.map((row) => ({
            label: row.label,
            value: row.format === "markdown" ? <span className="text-muted-foreground">{row.after}</span> : <BeforeAfter before={row.before} after={row.after} />,
          }))}
        />
      )}
      {counts.length > 0 && <p className="text-xs tabular-nums text-muted-foreground">{counts.map(([label, n]) => `${n.toLocaleString("en-US")} ${label}`).join(" · ")}</p>}
    </>
  )
}

function BeforeAfter({ before, after }: { before: string | null; after: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span className="sr-only">From </span>
      <del className="text-admin-subtle decoration-admin-subtle/60">{before ?? "Not set"}</del>
      <ArrowRight aria-hidden className="size-3 shrink-0 text-admin-subtle" />
      <span className="sr-only"> to </span>
      <ins className="font-medium no-underline">{after ?? "Not set"}</ins>
    </span>
  )
}

function FullChange({ detail }: { detail: JackProposalDetail }) {
  const short = detail.diff.filter((row) => !row.lines)
  const long = detail.diff.filter((row) => row.lines)
  return (
    <>
      {short.length > 0 && <DetailList items={short.map((row) => ({ label: row.label, value: <BeforeAfter before={row.before} after={row.after} /> }))} />}
      {long.map((row) => (
        <LineDiff key={row.field} row={row} />
      ))}
      {detail.preview && <MarkdownPreview preview={detail.preview} />}
      {detail.people.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-admin-subtle">Who it affects</span>
          <ul className="flex flex-wrap gap-1.5">
            {detail.people.map((person, i) => (
              <li key={i} className="rounded-full border bg-card px-2 py-0.5 text-xs">
                {person.name}
                {person.detail && <span className="text-admin-subtle"> · {person.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.links.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {detail.links.map((link, i) => (
            <li key={i} className="min-w-0 break-words">
              <PartLink url={link.url}>{link.title}</PartLink>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function linesLabel(stats?: { added: number; removed: number }) {
  if (!stats) return null
  const parts = [stats.added ? `${stats.added} added` : null, stats.removed ? `${stats.removed} removed` : null].filter(Boolean)
  return parts.length ? `Lines ${parts.join(", ")}` : "No lines changed"
}

/** Long text as removed and added lines, with a little unchanged context around them */
function LineDiff({ row }: { row: JackProposalDiffRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap gap-x-2 text-xs">
        <span className="font-medium text-foreground">{row.label}</span>
        <span className="text-admin-subtle">{linesLabel(row.stats)}</span>
      </span>
      <div className="max-h-96 overflow-y-auto rounded-md border bg-card py-1 font-mono text-xs leading-relaxed">
        {(row.lines ?? []).map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </div>
    </div>
  )
}

function DiffLineRow({ line }: { line: DiffHunkLine }) {
  if (line.op === "skip") return <div className="px-2.5 py-0.5 text-admin-subtle">{`⋯ ${line.count} unchanged line${line.count === 1 ? "" : "s"}`}</div>
  const mark = line.op === "add" ? "+" : line.op === "del" ? "−" : " "
  return (
    <div className={cn("flex gap-2 px-2.5", line.op === "add" && "bg-tone-success text-tone-success-foreground", line.op === "del" && "bg-tone-danger text-tone-danger-foreground")}>
      <span aria-hidden className="w-2.5 shrink-0 select-none">
        {mark}
      </span>
      {line.op !== "same" && <span className="sr-only">{line.op === "add" ? "Added: " : "Removed: "}</span>}
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || " "}</span>
    </div>
  )
}

/** Rows start picked when they matched (or have no status); ambiguous and unmatched ones start unpicked */
function defaultPicks(rows: JackProposalRow[]): string[] {
  return rows.filter((row) => !row.status || row.status === "matched").map((row) => row.id)
}

function Footer({ detail, state, onChanged }: { detail: JackProposalDetail; state: JackProposalState | null; onChanged: () => void }) {
  const room = useProposalRoom()
  const canAct = room !== null
  const confirm = useConfirm()
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[] | null>(null)
  const status = state?.status ?? detail.status
  const result = state?.result ?? detail.result
  const rows = detail.rows
  const picks = picked ?? (rows ? defaultPicks(rows) : [])
  const pending = status === "PENDING"

  async function apply() {
    if (!room || busy) return
    if (detail.destructive) {
      const ok = await confirm({
        title: `Apply “${detail.title}”?`,
        description: `${detail.summary} This can't be taken back.`,
        confirmLabel: rows ? `Apply ${picks.length} of ${rows.length}` : "Apply",
        tone: "danger",
      })
      if (!ok) return
    }
    setBusy("apply")
    setError(null)
    const problem = await room.apply(detail.id, rows ? picks : undefined)
    setBusy(null)
    if (problem) setError(problem)
    onChanged()
  }

  async function discard() {
    if (!room || busy) return
    setBusy("discard")
    setError(null)
    const problem = await room.discard(detail.id)
    setBusy(null)
    if (problem) setError(problem)
    onChanged()
  }

  return (
    <>
      {rows && rows.length > 0 && <RowPicker rows={rows} picks={picks} onChange={setPicked} editable={pending && canAct && detail.canApply && !busy} applied={status === "APPLIED" ? (result?.appliedRows ?? null) : null} />}
      {pending && canAct ? (
        <div className="flex flex-wrap items-center gap-2">
          {detail.canApply && (
            <Button size="sm" variant="primary" pending={busy === "apply"} disabled={busy !== null || (rows !== null && picks.length === 0)} onClick={() => void apply()}>
              {rows ? `Apply ${picks.length} of ${rows.length}` : "Apply"}
            </Button>
          )}
          <Button size="sm" variant="secondary" pending={busy === "discard"} disabled={busy !== null} onClick={() => void discard()}>
            Discard
          </Button>
          <span className="text-xs text-admin-subtle">
            {!detail.known
              ? "This version of the site can't apply this kind of change."
              : !detail.canApply && detail.permission === "admin"
                ? "Only an admin can apply this."
                : `Nothing changes until an officer applies it. Expires ${day.format(new Date(detail.expiresAt))}.`}
          </span>
        </div>
      ) : (
        <Outcome detail={detail} status={status} result={result} />
      )}
      {error && (
        <p role="alert" className="break-words text-xs font-medium text-tone-danger-foreground">
          {error}
        </p>
      )}
    </>
  )
}

function Outcome({ detail, status, result }: { detail: JackProposalDetail; status: JackProposalStatusKey; result: JackProposalDetail["result"] }) {
  const at = detail.decidedAt ? ` · ${when.format(new Date(detail.decidedAt))} CT` : ""
  const links = result?.links ?? []
  switch (status) {
    case "PENDING":
      return <p className="text-xs text-admin-subtle">Waiting for an officer to apply or discard it in its room.</p>
    case "APPLYING":
      return <p className="text-xs text-admin-subtle">{detail.decidedBy ? `${detail.decidedBy} is applying it.` : "An officer is applying it."}</p>
    case "APPLIED":
      return (
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {result?.summary ?? "Applied."} <span className="text-admin-subtle">{`Applied${detail.decidedBy ? ` by ${detail.decidedBy}` : ""}${at}`}</span>
          </span>
          {links.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {links.map((link, i) => (
                <li key={i} className="min-w-0 break-words">
                  <PartLink url={link.url}>{link.title}</PartLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    case "FAILED":
      return (
        <Notice tone="danger" title="Couldn't apply it">
          {result?.summary ?? "Something went wrong."}
        </Notice>
      )
    case "STALE":
      return (
        <Notice tone="neutral" title="Stale: not applied">
          {result?.summary ?? "What it changes has changed since."} {"Ask Jack for a new proposal if it's still wanted."}
        </Notice>
      )
    case "DISCARDED":
      return <p className="text-xs text-admin-subtle">{detail.decidedBy ? `Discarded by ${detail.decidedBy}${at}.` : "Discarded."}</p>
    case "SUPERSEDED":
      return <p className="text-xs text-admin-subtle">Replaced by a newer proposal further down the room.</p>
  }
}

/** A checkbox per row, for applying some and not others */
function RowPicker({
  rows,
  picks,
  onChange,
  editable,
  applied,
}: {
  rows: JackProposalRow[]
  picks: string[]
  onChange: (picks: string[]) => void
  editable: boolean
  /** After applying: the rows it applied */
  applied: string[] | null
}) {
  const chosen = new Set(applied ?? picks)
  const toggle = (id: string) => onChange(chosen.has(id) ? picks.filter((p) => p !== id) : [...picks, id])
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1 flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-foreground">
          {applied ? `Applied ${applied.length} of ${rows.length}` : `${picks.length} of ${rows.length} picked`}
        </span>
        {editable && (
          <>
            <button type="button" className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange(rows.map((row) => row.id))}>
              All
            </button>
            <button type="button" className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onChange([])}>
              None
            </button>
          </>
        )}
      </legend>
      <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md border bg-card">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-admin-row last:border-b-0">
            <label className={cn("flex items-start gap-2.5 px-2.5 py-1.5", editable && "cursor-pointer hover:bg-admin-surface")}>
              <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-primary" checked={chosen.has(row.id)} disabled={!editable} onChange={() => toggle(row.id)} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words">{row.label}</span>
                {row.detail && <span className="break-words text-xs text-admin-subtle">{row.detail}</span>}
              </span>
              {row.status && row.status !== "matched" && <Badge tone={row.status === "ambiguous" ? "warning" : "danger"}>{row.status === "ambiguous" ? "Ambiguous" : "No match"}</Badge>}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}
