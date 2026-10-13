"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useDebounce } from "use-debounce"
import { formatInTimeZone } from "date-fns-tz"
import { Loader2 } from "lucide-react"
import type { Prisma } from "@prisma/client"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import {
  Button,
  DetailList,
  EmptyState,
  JsonView,
  Notice,
  SearchInput,
  Select,
  Sheet,
  Table,
  TableFooter,
  TD,
  TH,
  THead,
  ToneText,
  Toolbar,
  TR,
  type Tone,
} from "@/components/admin/kit"
import { entityHref, humanizeCode } from "@/app/admin/audit/_components/audit-format"
import { LiveTailToggle } from "@/app/admin/audit/_components/live-tail-toggle"

type AuditUser = { id: string; displayName: string; handle: string; avatarUrl: string | null }

/** One audit row as /api/admin/audit-logs returns it (dates arrive as strings over JSON) */
export type AuditEntry = {
  id: string
  createdAt: Date | string
  actionType: string
  entityType: string
  entityId: string
  summary: string
  before: Prisma.JsonValue | null
  after: Prisma.JsonValue | null
  metadata: Prisma.JsonValue | null
  actor: AuditUser | null
  targetUser: AuditUser | null
}

type Option = { value: string; count: number }

const PAGE_SIZE = 50
const LIVE_INTERVAL_MS = 3000

const central = (date: Date | string, pattern: string) => formatInTimeZone(new Date(date), DEFAULT_TIMEZONE, pattern)

function actionTone(actionType: string): Tone {
  const action = actionType.toUpperCase()
  if (action.includes("DELETE") || action.includes("REVOKE") || action.includes("REFUND")) return "danger"
  if (action.includes("CREATE") || action.includes("GRANT")) return "success"
  return "neutral"
}

/** Keeps a link to the open entry in the address bar, without a navigation */
function setEntryParam(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set("entry", id)
  else url.searchParams.delete("entry")
  window.history.replaceState(window.history.state, "", url)
}

export function AuditConsole({ actionTypes, entityTypes, initialEntry }: { actionTypes: Option[]; entityTypes: Option[]; initialEntry: AuditEntry | null }) {
  const [logs, setLogs] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  // Whether the last page fetched was full; `total` can grow above the loaded window, so it can't tell
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search.trim(), 400)
  const [actionType, setActionType] = useState("")
  const [entityType, setEntityType] = useState("")
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<AuditEntry | null>(initialEntry)

  // The next page "Load more" asks for; a ref so the fetchers keep one identity while paging
  const nextPage = useRef(2)
  // Ignores answers to requests that a newer search or filter replaced
  const latestReset = useRef(0)

  const query = useCallback(
    (page: number) => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (debouncedSearch) params.set("search", debouncedSearch)
      if (actionType) params.set("actionType", actionType)
      if (entityType) params.set("entityType", entityType)
      return `/api/admin/audit-logs?${params}`
    },
    [debouncedSearch, actionType, entityType],
  )

  const fetchPage = useCallback(
    async (page: number): Promise<{ items: AuditEntry[]; total: number }> => {
      const res = await fetch(query(page), { cache: "no-store" })
      if (!res.ok) throw new Error(res.status === 403 ? "You no longer have access to the audit log." : "The audit log didn't load.")
      const data = await res.json()
      return { items: data.items, total: data.pagination.total }
    },
    [query],
  )

  const reload = useCallback(async () => {
    const ticket = ++latestReset.current
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPage(1)
      if (ticket !== latestReset.current) return
      setLogs(data.items)
      setTotal(data.total)
      setHasMore(data.items.length === PAGE_SIZE)
      nextPage.current = 2
    } catch (e) {
      if (ticket === latestReset.current) setError(e instanceof Error ? e.message : "The audit log didn't load.")
    } finally {
      if (ticket === latestReset.current) setLoading(false)
    }
  }, [fetchPage])

  // First load, and again whenever the search or a filter changes
  useEffect(() => {
    reload()
  }, [reload])

  const loadMore = async () => {
    const ticket = latestReset.current
    setLoadingMore(true)
    try {
      const data = await fetchPage(nextPage.current)
      // The search or a filter changed while this was loading: these rows belong to the old list
      if (ticket !== latestReset.current) return
      setHasMore(data.items.length === PAGE_SIZE)
      setLogs((prev) => {
        // New entries at the top shift the pages down, so a page can repeat rows we already have
        const seen = new Set(prev.map((log) => log.id))
        return [...prev, ...data.items.filter((log) => !seen.has(log.id))]
      })
      setTotal(data.total)
      nextPage.current += 1
    } catch (e) {
      if (ticket === latestReset.current) setError(e instanceof Error ? e.message : "The audit log didn't load.")
    } finally {
      setLoadingMore(false)
    }
  }

  // Live tail: every few seconds, add any new entries to the top (keeping what's already loaded).
  // Skips while the tab is hidden.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(async () => {
      if (document.hidden) return
      const ticket = latestReset.current
      try {
        const data = await fetchPage(1)
        if (ticket !== latestReset.current) return
        let replaced = false
        setLogs((prev) => {
          const seen = new Set(prev.map((log) => log.id))
          const fresh = data.items.filter((log) => !seen.has(log.id))
          // More than a page arrived since the last check (e.g. the tab was hidden): adding them on top would
          // leave a gap below them, so start over from the newest page
          if (prev.length && fresh.length === data.items.length && data.items.length === PAGE_SIZE) {
            replaced = true
            return data.items
          }
          return fresh.length ? [...fresh, ...prev] : prev
        })
        if (replaced) {
          nextPage.current = 2
          setHasMore(true)
        }
        setTotal(data.total)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : "The audit log didn't load.")
      }
    }, LIVE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [live, fetchPage])

  const open = (entry: AuditEntry) => {
    setSelected(entry)
    setEntryParam(entry.id)
  }
  const close = () => {
    setSelected(null)
    setEntryParam(null)
  }

  const filtered = !!(debouncedSearch || actionType || entityType)
  const clearFilters = () => {
    setSearch("")
    setActionType("")
    setEntityType("")
  }

  return (
    <div className="min-w-0">
      <Toolbar actions={<LiveTailToggle on={live} onChange={setLive} />}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search summaries" />
        <Select value={actionType} onChange={(e) => setActionType(e.target.value)} aria-label="Action" className="w-full sm:w-44">
          <option value="">All actions</option>
          {actionTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {humanizeCode(option.value)} ({option.count})
            </option>
          ))}
        </Select>
        <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Record type" className="w-full sm:w-44">
          <option value="">All records</option>
          {entityTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {humanizeCode(option.value)} ({option.count})
            </option>
          ))}
        </Select>
        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </Toolbar>

      {error && (
        <Notice
          tone="danger"
          title="Couldn't load the audit log"
          className="mb-3"
          action={
            <Button size="sm" onClick={reload}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
        <Table minWidth={760} className="rounded-none border-0">
          <THead>
            <TH className="w-36">When</TH>
            <TH>What happened</TH>
            <TH className="w-40">Who</TH>
            <TH className="w-32">Action</TH>
            <TH className="w-36">Record</TH>
          </THead>
          <tbody>
            {logs.map((log) => (
              <TR key={log.id} selected={selected?.id === log.id} onClick={() => open(log)} className="cursor-pointer hover:bg-admin-surface">
                <TD className="whitespace-nowrap text-muted-foreground">{central(log.createdAt, "MMM d, h:mm a")}</TD>
                <TD className="max-w-0">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      open(log)
                    }}
                    className="block w-full truncate text-left font-medium hover:underline" title={log.summary}>
                    {log.summary}
                  </button>
                </TD>
                <TD className="max-w-0">
                  <span className="block truncate">
                    {log.actor?.displayName ?? "System"}
                    {log.targetUser && <span className="text-admin-subtle"> → {log.targetUser.displayName}</span>}
                  </span>
                </TD>
                <TD className="whitespace-nowrap">
                  <ToneText tone={actionTone(log.actionType)}>{humanizeCode(log.actionType)}</ToneText>
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">{humanizeCode(log.entityType)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>

        {loading && logs.length === 0 && (
          <p className="flex items-center justify-center gap-2 px-6 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the audit log
          </p>
        )}
        {!loading && !error && logs.length === 0 && (
          <EmptyState
            title={filtered ? "No entries match" : "Nothing in the audit log yet"}
            description={filtered ? "Try a different search, or clear the filters." : "Changes officers make show up here."}
            action={filtered && <Button onClick={clearFilters}>Clear filters</Button>}
          />
        )}
        {logs.length > 0 && (
          <TableFooter>
            <span className="flex items-center gap-2">
              {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Showing {logs.length} of {total} {total === 1 ? "entry" : "entries"}
            </span>
            {hasMore && (
              <Button size="sm" onClick={loadMore} pending={loadingMore}>
                Load more
              </Button>
            )}
          </TableFooter>
        )}
      </div>

      <AuditEntrySheet entry={selected} onClose={close} />
    </div>
  )
}

function UserLink({ user }: { user: AuditUser }) {
  return (
    <Link href={`/admin/users/${user.id}/edit`} className="font-medium hover:underline">
      {user.displayName} <span className="font-normal text-admin-subtle">@{user.handle}</span>
    </Link>
  )
}

function AuditEntrySheet({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  const href = entry && !entry.actionType.toUpperCase().includes("DELETE") ? entityHref(entry.entityType, entry.entityId) : null
  const blocks = entry
    ? ([
        ["Before", entry.before],
        ["After", entry.after],
        ["Metadata", entry.metadata],
      ] as const).filter(([, value]) => value !== null && value !== undefined)
    : []

  return (
    <Sheet
      open={!!entry}
      onOpenChange={(open) => !open && onClose()}
      title={entry ? `${humanizeCode(entry.actionType)} · ${humanizeCode(entry.entityType)}` : "Audit entry"}
      description={entry ? `${central(entry.createdAt, "EEE, MMM d, yyyy, h:mm:ss a")} CT` : undefined}
    >
      {entry && (
        <div className="flex flex-col gap-5">
          <p className="text-[13px] font-medium">{entry.summary}</p>
          <DetailList
            items={[
              { label: "Done by", value: entry.actor ? <UserLink user={entry.actor} /> : "System" },
              ...(entry.targetUser ? [{ label: "Member", value: <UserLink user={entry.targetUser} /> }] : []),
              { label: "Action", value: <span className="font-mono text-xs">{entry.actionType}</span> },
              {
                label: "Record",
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs">{entry.entityType}</span>
                    <span className="break-all font-mono text-xs text-admin-subtle">{entry.entityId}</span>
                    {href && (
                      <Link href={href} className="w-fit text-xs font-medium hover:underline">
                        Open in admin
                      </Link>
                    )}
                  </span>
                ),
              },
              { label: "Entry ID", value: <span className="break-all font-mono text-xs text-admin-subtle">{entry.id}</span> },
            ]}
          />
          {blocks.length === 0 ? (
            <p className="text-xs text-admin-subtle">No before, after or metadata recorded for this change.</p>
          ) : (
            blocks.map(([label, value]) => (
              <section key={label} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground">{label}</h3>
                <JsonView value={value} />
              </section>
            ))
          )}
        </div>
      )}
    </Sheet>
  )
}
