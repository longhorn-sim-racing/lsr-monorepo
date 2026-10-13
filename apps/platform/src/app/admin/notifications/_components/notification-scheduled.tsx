"use client"

import { Fragment, useMemo, useState } from "react"
import { Bell, ChevronDown, ChevronRight, Mail } from "lucide-react"
import { toast } from "sonner"
import { Button, CellStack, EmptyState, Panel, Table, TableFooter, TD, TH, THead, TR, useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { cancelScheduledNotification } from "../actions"
import { centralTime, plural, scheduledSendKey, type NotificationRow } from "./format"

/** One scheduled send: the same message at the same time, to one or more members, on one or both channels. */
type ScheduledSend = {
  key: string
  title: string
  body: string
  actionUrl: string | null
  scheduledFor: Date
  rows: NotificationRow[]
  members: { id: string; displayName: string; email: string }[]
  channels: { email: boolean; inApp: boolean }
}

function groupSends(notifications: NotificationRow[]): ScheduledSend[] {
  const groups = new Map<string, ScheduledSend>()
  for (const n of notifications) {
    if (!n.scheduledFor) continue
    const scheduledFor = new Date(n.scheduledFor)
    const key = scheduledSendKey(n)
    let group = groups.get(key)
    if (!group) {
      group = { key, title: n.title, body: n.body, actionUrl: n.actionUrl, scheduledFor, rows: [], members: [], channels: { email: false, inApp: false } }
      groups.set(key, group)
    }
    group.rows.push(n)
    if (!group.members.some((m) => m.id === n.user.id)) group.members.push(n.user)
    if (n.channel === "EMAIL") group.channels.email = true
    else group.channels.inApp = true
  }
  return [...groups.values()].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
}

function Channels({ channels }: { channels: ScheduledSend["channels"] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {channels.inApp && (
        <span className="flex items-center gap-1.5">
          <Bell className="size-3.5 text-admin-subtle" aria-hidden />
          In-app
        </span>
      )}
      {channels.email && (
        <span className="flex items-center gap-1.5">
          <Mail className="size-3.5 text-admin-subtle" aria-hidden />
          Email
        </span>
      )}
    </span>
  )
}

export function NotificationScheduled({ notifications }: { notifications: NotificationRow[] }) {
  const confirm = useConfirm()
  const [cancelled, setCancelled] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<{ key: string; done: number; total: number } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const sends = useMemo(() => groupSends(notifications.filter((n) => !cancelled.has(n.id))), [notifications, cancelled])

  /** Cancels each notification in turn (one per member and channel), then reports how it went. */
  const cancelRows = async (key: string, rows: NotificationRow[]) => {
    setProgress({ key, done: 0, total: rows.length })
    let failed = 0
    let lastError: unknown
    for (const row of rows) {
      try {
        await cancelScheduledNotification(row.id)
        setCancelled((prev) => new Set(prev).add(row.id))
      } catch (error) {
        failed++
        lastError = error
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
    }
    setProgress(null)
    if (failed === 0) toast.success(rows.length === 1 ? "Cancelled" : `Cancelled ${plural(rows.length, "notification")}`)
    else toast.error(unexpectedError(lastError, `Couldn't cancel ${plural(failed, "notification")}`))
  }

  const cancelSend = async (send: ScheduledSend) => {
    const ok = await confirm({
      tone: "danger",
      title: `Cancel "${send.title}"?`,
      description: `It won't go to ${send.members.length === 1 ? send.members[0].displayName : plural(send.members.length, "member")} on ${centralTime(send.scheduledFor, "MMM d 'at' h:mm a")}. To send it later, compose it again.`,
      confirmLabel: "Cancel send",
      cancelLabel: "Keep it",
    })
    if (ok) await cancelRows(send.key, send.rows)
  }

  const cancelMember = async (send: ScheduledSend, member: ScheduledSend["members"][number]) => {
    const ok = await confirm({
      tone: "danger",
      title: `Cancel it for ${member.displayName}?`,
      description: `"${send.title}" still goes to everyone else.`,
      confirmLabel: "Cancel for them",
      cancelLabel: "Keep it",
    })
    if (ok) await cancelRows(send.key, send.rows.filter((row) => row.user.id === member.id))
  }

  if (sends.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing scheduled" description="Schedule a notification from the Compose tab and it waits here until it goes out." />
      </Panel>
    )
  }

  return (
    <Panel className="overflow-hidden">
      <Table minWidth={720} className="rounded-none border-0">
        <THead>
          <TH className="w-8">
            <span className="sr-only">Recipients</span>
          </TH>
          <TH>Notification</TH>
          <TH>Recipients</TH>
          <TH>Channels</TH>
          <TH>Goes out</TH>
          <TH className="w-px">
            <span className="sr-only">Actions</span>
          </TH>
        </THead>
        <tbody>
          {sends.map((send) => {
            const open = expanded === send.key
            const busy = progress?.key === send.key
            return (
              <Fragment key={send.key}>
                <TR selected={open} className={cn(open && "border-b-0")}>
                  <TD className="pr-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : send.key)}
                      aria-expanded={open}
                      aria-label={open ? "Hide recipients" : "Show recipients"}
                      className="flex size-6 items-center justify-center rounded text-admin-subtle hover:bg-accent hover:text-foreground"
                    >
                      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </TD>
                  <TD className="max-w-[320px]">
                    <CellStack primary={send.title} secondary={send.body} />
                  </TD>
                  <TD className="max-w-[200px]">
                    {send.members.length === 1 ? (
                      <CellStack primary={send.members[0].displayName} secondary={send.members[0].email} />
                    ) : (
                      <span className="font-medium">{plural(send.members.length, "member")}</span>
                    )}
                  </TD>
                  <TD>
                    <Channels channels={send.channels} />
                  </TD>
                  <TD className="whitespace-nowrap">{centralTime(send.scheduledFor, "EEE, MMM d, h:mm a")}</TD>
                  <TD className="px-2 py-1 text-right">
                    <Button size="sm" variant="danger" onClick={() => cancelSend(send)} pending={busy} disabled={!!progress && !busy}>
                      {busy && progress ? `Cancelling ${progress.done + 1}/${progress.total}` : "Cancel"}
                    </Button>
                  </TD>
                </TR>
                {open && (
                  <tr className="border-b border-admin-row bg-admin-selected last:border-b-0">
                    <td colSpan={6} className="px-4 pb-4 pt-1">
                      <div className="rounded-md border bg-card sm:ml-8">
                        {send.actionUrl && (
                          <p className="border-b border-admin-row px-3 py-2 text-xs text-admin-subtle">
                            Links to <span className="break-all text-foreground">{send.actionUrl}</span>
                          </p>
                        )}
                        <ul className="max-h-72 overflow-y-auto">
                          {send.members.map((member) => (
                            <li key={member.id} className="flex items-center justify-between gap-3 border-b border-admin-row px-3 py-1.5 last:border-b-0">
                              <CellStack primary={member.displayName} secondary={member.email} />
                              <Button size="sm" variant="ghost" onClick={() => cancelMember(send, member)} disabled={!!progress}>
                                Cancel for them
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </Table>
      <TableFooter>
        <span>
          {plural(sends.length, "scheduled send")} · {plural(sends.reduce((sum, send) => sum + send.rows.length, 0), "notification")} in all
        </span>
      </TableFooter>
    </Panel>
  )
}
