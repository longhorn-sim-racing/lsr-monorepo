"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Button, Field, FieldGrid, FormActions, Input, Notice, Panel, PanelBody, PanelFooter, PanelHeader, Select, useConfirm } from "@/components/admin/kit"
import { bulkDeleteNotifications, type BulkDeleteFilter } from "../actions"
import { plural } from "./format"

const STATUS_LABEL: Record<NonNullable<BulkDeleteFilter["status"]>, string> = {
  SENT: "Sent",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  PENDING: "Pending",
}

export function NotificationCleanup() {
  const confirm = useConfirm()
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<string>("")
  const [olderThanDays, setOlderThanDays] = useState<string>("")
  const [lastResult, setLastResult] = useState<{ deletedCount: number } | null>(null)

  const filter: BulkDeleteFilter = {}
  if (status && status !== "all") filter.status = status as BulkDeleteFilter["status"]
  const days = parseInt(olderThanDays)
  if (days > 0) filter.olderThanDays = days
  const hasFilter = !!filter.status || !!filter.olderThanDays

  const handleBulkDelete = async () => {
    if (!hasFilter) {
      toast.error("Pick a status, a number of days, or both.")
      return
    }

    const what = [
      "every notification",
      filter.status ? `with status ${STATUS_LABEL[filter.status]}` : null,
      filter.olderThanDays ? `older than ${plural(filter.olderThanDays, "day")}` : null,
    ]
      .filter(Boolean)
      .join(" ")
    const ok = await confirm({
      tone: "danger",
      title: "Delete matching notifications?",
      description: `This deletes ${what}, for every member. It's logged in the audit log and can't be undone.`,
      confirmLabel: "Delete them",
    })
    if (!ok) return

    startTransition(async () => {
      try {
        const result = await bulkDeleteNotifications(filter)
        setLastResult(result)
        toast.success(`Deleted ${plural(result.deletedCount, "notification")}`)
        setStatus("")
        setOlderThanDays("")
      } catch {
        toast.error("Failed to delete notifications")
      }
    })
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Panel>
        <PanelHeader title="Bulk delete" description="Permanently delete old notifications to keep the activity list and database tidy." />
        <PanelBody className="flex flex-col gap-4">
          <FieldGrid>
            <Field label="Status" htmlFor="cleanup-status">
              <Select id="cleanup-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any status</option>
                <option value="SENT">Sent</option>
                <option value="FAILED">Failed</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="PENDING">Pending (includes scheduled)</option>
              </Select>
            </Field>
            <Field label="Older than (days)" htmlFor="cleanup-days" hint="Counted from when each was created">
              <Input id="cleanup-days" type="number" min="1" inputMode="numeric" value={olderThanDays} onChange={(e) => setOlderThanDays(e.target.value)} placeholder="30" />
            </Field>
          </FieldGrid>
          <Notice tone="warning" title="This can't be undone">
            Deleted notifications are removed from the database, including from members&apos; bells. Check the filters before you confirm.
          </Notice>
        </PanelBody>
        <PanelFooter>
          <FormActions
            className="w-full"
            note={lastResult ? `Last cleanup deleted ${plural(lastResult.deletedCount, "notification")}.` : "Pick at least one filter."}
          >
            <Button variant="danger-solid" onClick={handleBulkDelete} pending={isPending} disabled={!hasFilter}>
              Delete matching
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </div>
  )
}
