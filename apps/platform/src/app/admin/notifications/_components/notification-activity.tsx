"use client"

import { Fragment, useState } from "react"
import { Bell, ChevronDown, ChevronRight, Mail, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  CellStack,
  DetailList,
  EmptyState,
  Panel,
  RowActions,
  RowMenu,
  Table,
  TableFooter,
  TD,
  TH,
  THead,
  ToneText,
  TR,
  useConfirm,
} from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { DELIVERY_LABEL } from "@/lib/email-delivery"
import { cn } from "@/lib/utils"
import { retryFailedNotification, deleteNotificationAdmin, getRecentNotifications } from "../actions"
import { centralTime, STATUS, typeLabel, type NotificationRow } from "./format"

const PAGE_SIZE = 20

function StatusBadge({ notification }: { notification: NotificationRow }) {
  if (notification.status === "PENDING" && notification.scheduledFor && new Date(notification.scheduledFor) > new Date()) {
    return <Badge tone="info">Scheduled</Badge>
  }
  const { label, tone } = STATUS[notification.status]
  return <Badge tone={tone}>{label}</Badge>
}

function Channel({ notification }: { notification: NotificationRow }) {
  if (notification.channel === "EMAIL") {
    return (
      <span className="flex items-center gap-1.5">
        <Mail className="size-3.5 text-admin-subtle" aria-hidden />
        Email
      </span>
    )
  }
  return (
    <span className="flex flex-col">
      <span className="flex items-center gap-1.5">
        <Bell className="size-3.5 text-admin-subtle" aria-hidden />
        In-app
      </span>
      <ToneText tone={notification.dismissedAt ? "warning" : notification.readAt ? "success" : "neutral"} className="font-medium">
        {notification.dismissedAt ? "Dismissed" : notification.readAt ? "Read" : "Unread"}
      </ToneText>
    </span>
  )
}

/** What happened after Resend took the email, from its delivery events; a dash when there's no report (in-app, not sent, or tracking not set up) */
function Delivery({ notification }: { notification: NotificationRow }) {
  if (notification.channel !== "EMAIL" || !notification.delivery) return <span className="text-admin-subtle">—</span>
  const { label, tone, hint } = DELIVERY_LABEL[notification.delivery.status]
  return (
    <span title={notification.delivery.reason ? `${hint}. ${notification.delivery.reason}` : hint}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  )
}

function Details({ notification }: { notification: NotificationRow }) {
  const items: { label: React.ReactNode; value: React.ReactNode }[] = [
    { label: "Title", value: <span className="font-medium">{notification.title}</span> },
    { label: "Message", value: <span className="whitespace-pre-wrap">{notification.body}</span> },
  ]
  if (notification.actionUrl) {
    items.push({
      label: "Link",
      value: (
        <a href={notification.actionUrl} target="_blank" rel="noreferrer" className="break-all text-tone-info-foreground hover:underline">
          {notification.actionUrl}
        </a>
      ),
    })
  }
  items.push({ label: "Type", value: typeLabel(notification.type) })
  items.push({ label: "Member", value: `${notification.user.displayName} · ${notification.user.email}` })
  items.push({ label: "Created", value: centralTime(notification.createdAt, "MMM d, yyyy, h:mm a") })
  if (notification.scheduledFor) items.push({ label: "Scheduled for", value: centralTime(notification.scheduledFor, "MMM d, yyyy, h:mm a") })
  if (notification.sentAt) items.push({ label: "Sent", value: centralTime(notification.sentAt, "MMM d, yyyy, h:mm a") })
  if (notification.channel === "IN_APP") {
    items.push({ label: "Read", value: notification.readAt ? centralTime(notification.readAt, "MMM d, yyyy, h:mm a") : "Not yet" })
    items.push({ label: "Dismissed", value: notification.dismissedAt ? centralTime(notification.dismissedAt, "MMM d, yyyy, h:mm a") : "No" })
  }
  if (notification.delivery) {
    const { label, hint } = DELIVERY_LABEL[notification.delivery.status]
    items.push({
      label: "Delivery",
      value: (
        <span>
          {label} ({centralTime(notification.delivery.at, "MMM d, h:mm a")}): {hint}
          {notification.delivery.reason && <span className="block text-admin-subtle">{notification.delivery.reason}</span>}
        </span>
      ),
    })
  }
  if (notification.emailError) {
    items.push({ label: "Error", value: <span className="break-words text-tone-danger-foreground">{notification.emailError}</span> })
  }
  return <DetailList items={items} />
}

export function NotificationActivity({ notifications: initial, total }: { notifications: NotificationRow[]; total: number }) {
  const confirm = useConfirm()
  // The list starts from the server's first page; it's replaced when the page re-renders after an action
  const [source, setSource] = useState(initial)
  const [items, setItems] = useState(initial)
  const [hasMore, setHasMore] = useState(initial.length >= PAGE_SIZE)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  if (source !== initial) {
    setSource(initial)
    setItems(initial)
    setHasMore(initial.length >= PAGE_SIZE)
  }

  const loadMore = async () => {
    setIsLoadingMore(true)
    try {
      const newItems = await getRecentNotifications(PAGE_SIZE, items.length)
      if (newItems.length < PAGE_SIZE) setHasMore(false)
      setItems((prev) => [...prev, ...newItems.filter((n) => !prev.some((p) => p.id === n.id))])
    } catch (error) {
      toast.error(unexpectedError(error, "Couldn't load more notifications"))
    } finally {
      setIsLoadingMore(false)
    }
  }

  const retry = async (notification: NotificationRow) => {
    setBusyId(notification.id)
    try {
      await retryFailedNotification(notification.id)
      // Reload what's on screen so the new status shows
      const fresh = await getRecentNotifications(Math.max(items.length, PAGE_SIZE), 0)
      setItems(fresh)
      const after = fresh.find((n) => n.id === notification.id)
      if (after?.status === "FAILED") toast.error("It failed again. Check the error below.")
      else toast.success("Retried")
    } catch (error) {
      toast.error(unexpectedError(error, "Couldn't retry the notification"))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (notification: NotificationRow) => {
    setBusyId(notification.id)
    try {
      await deleteNotificationAdmin(notification.id)
      setItems((prev) => prev.filter((n) => n.id !== notification.id))
      toast.success("Notification deleted")
    } catch (error) {
      toast.error(unexpectedError(error, "Couldn't delete the notification"))
    } finally {
      setBusyId(null)
    }
  }

  const confirmRemove = async (notification: NotificationRow) => {
    const ok = await confirm({
      tone: "danger",
      title: "Delete this notification?",
      description: `It's removed for ${notification.user.displayName} too, if it's an in-app one. This can't be undone.`,
    })
    if (ok) await remove(notification)
  }

  if (items.length === 0) {
    return (
      <Panel>
        <EmptyState title="No notifications yet" description="Registrations, results and announcements you send from Compose show up here." />
      </Panel>
    )
  }

  return (
    <Panel className="overflow-hidden">
      <Table minWidth={860} className="rounded-none border-0">
        <THead>
          <TH className="w-8">
            <span className="sr-only">Details</span>
          </TH>
          <TH>Member</TH>
          <TH>Notification</TH>
          <TH>Channel</TH>
          <TH>Status</TH>
          <TH>Delivery</TH>
          <TH>Created</TH>
          <TH className="w-px">
            <span className="sr-only">Actions</span>
          </TH>
        </THead>
        <tbody>
          {items.map((notification) => {
            const expanded = expandedId === notification.id
            const toggle = () => setExpandedId(expanded ? null : notification.id)
            return (
              <Fragment key={notification.id}>
                <TR
                  selected={expanded}
                  className={cn("cursor-pointer hover:bg-admin-surface", expanded && "border-b-0")}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a, button, [role=menuitem]")) return
                    toggle()
                  }}
                >
                  <TD className="pr-0">
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={expanded}
                      aria-label={expanded ? "Hide details" : "Show details"}
                      className="flex size-6 items-center justify-center rounded text-admin-subtle hover:bg-accent hover:text-foreground"
                    >
                      {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </TD>
                  <TD className="max-w-[220px]">
                    <CellStack primary={notification.user.displayName} secondary={notification.user.email} />
                  </TD>
                  <TD className="max-w-[280px]">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{notification.title}</span>
                      <span className="truncate text-xs text-admin-subtle">{typeLabel(notification.type)}</span>
                    </span>
                  </TD>
                  <TD>
                    <Channel notification={notification} />
                  </TD>
                  <TD>
                    <StatusBadge notification={notification} />
                  </TD>
                  <TD>
                    <Delivery notification={notification} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{centralTime(notification.createdAt)}</TD>
                  <TD className="px-2 py-1">
                    <RowActions>
                      <RowMenu
                        label={`Actions for the notification to ${notification.user.displayName}`}
                        items={[
                          ...(notification.status === "FAILED"
                            ? [{ label: "Retry", onSelect: () => retry(notification), disabled: busyId === notification.id }, "separator" as const]
                            : []),
                          {
                            label: "Delete",
                            disabled: busyId === notification.id,
                            destructive: {
                              title: "Delete this notification?",
                              description: `It's removed for ${notification.user.displayName} too, if it's an in-app one. This can't be undone.`,
                            },
                            onSelect: () => remove(notification),
                          },
                        ]}
                      />
                    </RowActions>
                  </TD>
                </TR>
                {expanded && (
                  <tr className="border-b border-admin-row bg-admin-selected last:border-b-0">
                    <td colSpan={8} className="px-4 pb-4 pt-1">
                      <div className="flex flex-col gap-3 rounded-md border bg-card p-3.5 sm:ml-8">
                        <Details notification={notification} />
                        <div className="flex flex-wrap gap-2">
                          {notification.status === "FAILED" && (
                            <Button size="sm" onClick={() => retry(notification)} pending={busyId === notification.id}>
                              {busyId !== notification.id && <RefreshCw aria-hidden />}
                              Retry
                            </Button>
                          )}
                          <Button size="sm" variant="danger" onClick={() => confirmRemove(notification)} disabled={busyId === notification.id}>
                            Delete
                          </Button>
                        </div>
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
          Showing {items.length.toLocaleString()} of {Math.max(total, items.length).toLocaleString()}, newest first
        </span>
        {hasMore && (
          <Button size="sm" onClick={loadMore} pending={isLoadingMore}>
            Load more
          </Button>
        )}
      </TableFooter>
    </Panel>
  )
}
