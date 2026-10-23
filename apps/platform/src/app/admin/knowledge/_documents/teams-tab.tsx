import { formatInTimeZone } from "date-fns-tz"
import { EmptyState, Pager, Panel, Table, TD, TH, THead, TR } from "@/components/admin/kit"
import { PartLink } from "@/components/jack/parts/part-link"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { teamsConnector } from "@/server/connectors/teams/connector"
import { teamsMessageHref } from "@/server/jack/search/links"
import { DOCUMENTS_PAGE_SIZE, listTeamsMessages } from "@/server/queries/documents"
import type { KnowledgeSearchParams } from "../_tabs/types"
import { hrefFor, NotConnected, pageParam, paramOf } from "./documents-tab"
import { SyncedFilters } from "./filters"

/**
 * The Teams messages tab (design §9, §13): the officers' channel messages Jack searches, newest first.
 * Shown only while the Teams connector is switched on, as search and read are.
 */
export async function TeamsTab({ searchParams }: { searchParams: KnowledgeSearchParams }) {
  if (!(await teamsConnector.enabled())) {
    return (
      <NotConnected title="Teams isn't connected">
        Microsoft Teams is switched off or not set up yet (it waits on UT IT&apos;s approval). Once an admin connects it on Connections, the officers&apos; channel messages show here and Jack can search them.
      </NotConnected>
    )
  }
  const q = (paramOf(searchParams, "q") ?? "").trim().slice(0, 200)
  const channel = paramOf(searchParams, "channel")
  const list = await listTeamsMessages({ q, channelId: channel, page: pageParam(searchParams) })
  const first = (list.page - 1) * DOCUMENTS_PAGE_SIZE + 1

  return (
    <>
      <SyncedFilters placeholder="Search messages and authors" select={{ param: "channel", label: "Channel", options: list.channels.map((c) => ({ value: c.id, label: `#${c.name} (${c.messages})` })) }} />
      {list.rows.length === 0 ? (
        <Panel>
          {q ? (
            <EmptyState title="No messages match" description={`Nothing matches “${q}”. Try other words, or another channel.`} />
          ) : (
            <EmptyState title="No messages yet" description="The daily Teams sync copies each configured channel's messages in, and change notifications keep them current. Scheduled jobs shows its runs." />
          )}
        </Panel>
      ) : (
        <>
          <Table minWidth={760}>
            <THead>
              <TH>Message</TH>
              <TH>Channel</TH>
              <TH>From</TH>
              <TH className="text-right">Sent</TH>
            </THead>
            <tbody>
              {list.rows.map((row) => (
                <TR key={row.id}>
                  <TD className="max-w-[440px]">
                    <p className="line-clamp-3 whitespace-pre-line break-words">{row.excerpt || <span className="text-admin-subtle">(no text)</span>}</p>
                    <div className="mt-0.5 text-xs text-admin-subtle">
                      {row.replyToId ? "Reply · " : ""}
                      {row.editedAt ? "Edited · " : ""}
                      <PartLink url={teamsMessageHref(row, row.teamId)} className="text-xs">
                        Open in Teams
                      </PartLink>
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{row.channelName ? `#${row.channelName}` : "Unknown channel"}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{row.authorName}</TD>
                  <TD className="whitespace-nowrap text-right text-muted-foreground">{formatInTimeZone(row.createdAt, DEFAULT_TIMEZONE, "MMM d, h:mm a")}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <Pager page={list.page} pageCount={list.pageCount} hrefFor={hrefFor(searchParams, ["q", "channel"])} summary={`${first}–${first + list.rows.length - 1} of ${list.total}`} />
        </>
      )}
    </>
  )
}
