"use client"

import { useState } from "react"
import type { Event } from "@prisma/client"
import { Button, Field, Input, Notice, Panel, PanelBody, PanelFooter, PanelHeader, SwitchField } from "@/components/admin/kit"
import { updateEventAttendanceConfig } from "@/app/admin/events/actions"
import { useAction } from "@/app/admin/events/_components/use-action"
import { DEFAULT_TIMEZONE, dateToZonedValue, zoneLabel } from "@/lib/dates"

export function AttendanceConfigForm({ event, checkInCount = 0 }: { event: Event; checkInCount?: number }) {
  const timezone = event.timezone || DEFAULT_TIMEZONE
  const zone = zoneLabel(event.startsAtUtc, timezone)
  const [enabled, setEnabled] = useState(event.attendanceEnabled)
  const [opensAt, setOpensAt] = useState(dateToZonedValue(event.attendanceOpensAt, timezone))
  const [closesAt, setClosesAt] = useState(dateToZonedValue(event.attendanceClosesAt, timezone))
  const { run, pending } = useAction()

  const toggle = (checked: boolean) => {
    setEnabled(checked)
    // Turning it on with no window: default to the event's own times
    if (checked) {
      if (!opensAt) setOpensAt(dateToZonedValue(event.startsAtUtc, timezone))
      if (!closesAt) setClosesAt(dateToZonedValue(event.endsAtUtc, timezone))
    }
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    run(() => updateEventAttendanceConfig(event.id, formData), { success: "Check-in settings saved", error: "Couldn't save the check-in settings" })
  }

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <PanelHeader title="Check-in settings" description={`Times are in ${zone} (${timezone}).`} />
        <PanelBody className="flex flex-col gap-4">
          <SwitchField
            name="attendanceEnabled"
            checked={enabled}
            onCheckedChange={toggle}
            label="Check people in"
            description="On: members scan the QR code to be marked as attended. Off: everyone registered counts as attended once the event ends."
          />
          {!enabled && event.attendanceEnabled && checkInCount > 0 && (
            <Notice tone="warning" title="Check-ins will be hidden">
              Turning this off hides the {checkInCount} existing {checkInCount === 1 ? "check-in" : "check-ins"} from attendance reports.
            </Notice>
          )}
          <Field label={`Opens (${zone})`} htmlFor="attendanceOpensAt" hint="Blank opens it whenever check-in is on">
            <Input id="attendanceOpensAt" name="attendanceOpensAt" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </Field>
          <Field label={`Closes (${zone})`} htmlFor="attendanceClosesAt" hint="Blank keeps it open">
            <Input id="attendanceClosesAt" name="attendanceClosesAt" type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </Field>
        </PanelBody>
        <PanelFooter className="justify-end">
          <Button type="submit" pending={pending}>
            Save settings
          </Button>
        </PanelFooter>
      </Panel>
    </form>
  )
}
