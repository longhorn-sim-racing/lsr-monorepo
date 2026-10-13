"use client"

import { useState } from "react"
import type { EventStatus } from "@prisma/client"
import { Button, DetailList, Dialog, Field, Notice, Select } from "@/components/admin/kit"
import { updateEventStatus } from "@/app/admin/events/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { EVENT_STATUS, EVENT_STATUSES, EventStatusBadge } from "@/app/admin/events/_components/event-status"

type OverrideTarget = {
  id: string
  title: string
  status: EventStatus
  effectiveStatus: EventStatus
  publishedAt: Date | null
}

type Props = {
  /** The event to override; null keeps the dialog closed */
  event: OverrideTarget | null
  onOpenChange: (open: boolean) => void
  /** The publish time, already formatted, for scheduled events */
  scheduledNote?: string | null
}

/** Sets an event's saved status by hand, past the automatic time-based status. */
export function StatusOverrideDialog({ event, ...props }: Props) {
  return event ? <OverrideDialog key={event.id} event={event} {...props} /> : null
}

function OverrideDialog({ event, onOpenChange, scheduledNote }: Props & { event: OverrideTarget }) {
  const [status, setStatus] = useState<EventStatus>(event.status)
  const { run, pending } = useAction()
  const derived = event.status !== event.effectiveStatus

  const save = async () => {
    // Keeps the saved publish time. The action redirects back to the list.
    const ok = await run(() => updateEventStatus(event.id, status, event.publishedAt ?? undefined), {
      success: `Status set to ${EVENT_STATUS[status].label.toLowerCase()}`,
      error: "Couldn't change the status",
    })
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Override status"
      description={`${event.title}. This replaces the automatic, time-based status until it's changed again.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" pending={pending} disabled={status === event.status} onClick={save}>
            Save status
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <DetailList
          items={[
            { label: "Saved status", value: <EventStatusBadge status={event.status} /> },
            {
              label: "Shown as",
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <EventStatusBadge status={event.effectiveStatus} />
                  {derived && <span className="text-xs text-admin-subtle">Worked out from the event&apos;s times</span>}
                </span>
              ),
            },
            ...(event.status === "SCHEDULED" && scheduledNote ? [{ label: "Publishes", value: scheduledNote }] : []),
          ]}
        />
        <Field label="New status" htmlFor="override-status" hint={EVENT_STATUS[status].meaning}>
          <Select id="override-status" value={status} onChange={(e) => setStatus(e.target.value as EventStatus)}>
            {EVENT_STATUSES.map((option) => (
              <option key={option} value={option}>
                {EVENT_STATUS[option].label}
              </option>
            ))}
          </Select>
        </Field>
        {status === "SCHEDULED" && !event.publishedAt && (
          <Notice tone="warning">This event has no publish time, so it would stay hidden. Use Schedule on the edit page to set one.</Notice>
        )}
      </div>
    </Dialog>
  )
}
