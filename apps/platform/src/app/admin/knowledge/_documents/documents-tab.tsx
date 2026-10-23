import type { ReactNode } from "react"
import Link from "next/link"
import { formatInTimeZone } from "date-fns-tz"
import { Badge, Button, EmptyState, Notice, Pager, Panel, Table, TD, TH, THead, TR, type Tone } from "@/components/admin/kit"
import { PartLink } from "@/components/jack/parts/part-link"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { DOCUMENT_SOURCE_LABEL, DOCUMENT_SOURCES, enabledDocumentSources } from "@/server/connectors/documents/sources"
import { DOCUMENTS_PAGE_SIZE, listDocuments } from "@/server/queries/documents"
import type { KnowledgeSearchParams } from "../_tabs/types"
import { SyncedFilters } from "./filters"

/** Why a document has no (or only part of its) text; nothing is shown for "ok" */
const TEXT_STATUS: Record<string, { label: string; tone: Tone }> = {
  truncated: { label: "Partial text", tone: "info" },
  too_large: { label: "Too large to read", tone: "neutral" },
  unsupported: { label: "Text not read", tone: "neutral" },
  restricted: { label: "Downloads off", tone: "warning" },
  none: { label: "No text", tone: "neutral" },
  error: { label: "Couldn't read", tone: "warning" },
}

export function paramOf(searchParams: KnowledgeSearchParams, key: string): string | undefined {
  const value = searchParams[key]
  return Array.isArray(value) ? value[0] : value
}

export function pageParam(searchParams: KnowledgeSearchParams): number {
  const page = Number.parseInt(paramOf(searchParams, "page") ?? "", 10)
  return Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1
}

/** The tab's link for another page, keeping its filters */
export function hrefFor(searchParams: KnowledgeSearchParams, keys: string[]) {
  return (page: number) => {
    const params = new URLSearchParams()
    for (const key of ["tab", ...keys]) {
      const value = paramOf(searchParams, key)
      if (value) params.set(key, value)
    }
    if (page > 1) params.set("page", String(page))
    return `/admin/knowledge?${params}`
  }
}

export function NotConnected({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <EmptyState
        title={title}
        description={children}
        action={
          <Button asChild>
            <Link href="/admin/connections">Open Connections</Link>
          </Button>
        }
      />
    </Panel>
  )
}

/**
 * The Documents tab (design §9, §13): the Drive and SharePoint documents Jack searches, from the sources
 * an admin has switched on. Read-only here; files are edited in Drive or SharePoint.
 */
export async function DocumentsTab({ searchParams }: { searchParams: KnowledgeSearchParams }) {
  const enabled = await enabledDocumentSources()
  if (!enabled.length) {
    return (
      <NotConnected title="Documents aren't connected">
        Google Drive and SharePoint are switched off or not set up yet. Once an admin connects one on Connections, its documents show here and Jack can search them.
      </NotConnected>
    )
  }
  const off = DOCUMENT_SOURCES.filter((s) => !enabled.includes(s.source))
  const q = (paramOf(searchParams, "q") ?? "").trim().slice(0, 200)
  const source = paramOf(searchParams, "source")
  const list = await listDocuments({ q, source, sources: enabled, page: pageParam(searchParams) })
  const all = Object.values(list.counts).reduce((sum, n) => sum + n, 0)
  const first = (list.page - 1) * DOCUMENTS_PAGE_SIZE + 1

  return (
    <>
      {off.length > 0 && (
        <Notice
          className="mb-3"
          title={`${off.map((s) => s.label).join(" and ")} ${off.length === 1 ? "isn't" : "aren't"} connected`}
          action={
            <Button size="sm" asChild>
              <Link href="/admin/connections">Connections</Link>
            </Button>
          }
        >
          Only {enabled.map((s) => DOCUMENT_SOURCE_LABEL[s]).join(" and ")} documents are listed here and searched by Jack.
        </Notice>
      )}
      <SyncedFilters
        placeholder="Search names, folders and text"
        segments={{ param: "source", label: "Where", options: [{ value: "", label: "All", count: all }, ...enabled.map((s) => ({ value: s, label: DOCUMENT_SOURCE_LABEL[s], count: list.counts[s] ?? 0 }))] }}
      />
      {list.rows.length === 0 ? (
        <Panel>
          {q ? (
            <EmptyState title="No documents match" description={`Nothing matches “${q}”. Try other words.`} />
          ) : (
            <EmptyState title="No documents yet" description="The sync job copies the documents in. If it's on, the first run may still be going; Scheduled jobs shows its runs." />
          )}
        </Panel>
      ) : (
        <>
          <Table minWidth={760}>
            <THead>
              <TH>Document</TH>
              <TH>Folder</TH>
              <TH>Where</TH>
              <TH className="text-right">Modified</TH>
            </THead>
            <tbody>
              {list.rows.map((row) => {
                const status = TEXT_STATUS[row.textStatus]
                return (
                  <TR key={row.id}>
                    <TD className="max-w-[380px]">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {row.webUrl ? <PartLink url={row.webUrl}>{row.name}</PartLink> : <span className="font-medium">{row.name}</span>}
                        {status && <Badge tone={status.tone}>{status.label}</Badge>}
                      </div>
                    </TD>
                    <TD className="max-w-[240px] truncate text-muted-foreground" title={row.path}>
                      {row.path}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{DOCUMENT_SOURCE_LABEL[row.source] ?? row.source}</TD>
                    <TD className="whitespace-nowrap text-right text-muted-foreground">{formatInTimeZone(row.modifiedAt, DEFAULT_TIMEZONE, "MMM d, yyyy")}</TD>
                  </TR>
                )
              })}
            </tbody>
          </Table>
          <Pager page={list.page} pageCount={list.pageCount} hrefFor={hrefFor(searchParams, ["q", "source"])} summary={`${first}–${first + list.rows.length - 1} of ${list.total}`} />
        </>
      )}
    </>
  )
}
