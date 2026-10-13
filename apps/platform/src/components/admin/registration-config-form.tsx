"use client"

import { useState } from "react"
import type { Event } from "@prisma/client"
import { toast } from "sonner"
import { Button, Field, FormSection, Input, MoneyInput, Notice, Panel, PanelBody, PanelFooter, PanelHeader, SwitchField } from "@/components/admin/kit"
import { updateEventRegistrationConfig } from "@/app/admin/events/actions"
import { DEFAULT_TIMEZONE, dateToZonedValue, zoneLabel } from "@/lib/dates"
import { centsToDollarInput, dollarsToCents } from "@/lib/money"
import { useFormAction } from "./use-form-action"

export function RegistrationConfigForm({ event }: { event: Event }) {
  const timezone = event.timezone || DEFAULT_TIMEZONE
  const zone = zoneLabel(event.startsAtUtc, timezone)
  const [fee, setFee] = useState(centsToDollarInput(event.registrationFeeCents || null))
  const [autoPromote, setAutoPromote] = useState(event.waitlistAutoPromote)
  const isPaid = (dollarsToCents(fee) ?? 0) > 0
  const { onSubmit, error, pending } = useFormAction(
    (formData) => updateEventRegistrationConfig(event.id, formData),
    () => toast.success("Registration settings saved"),
  )

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <PanelHeader title="Registration settings" description={`Times are in ${zone} (${timezone}).`} />
        <PanelBody className="flex flex-col gap-5">
          <FormSection title="Sign-ups">
            <SwitchField name="registrationEnabled" defaultChecked={event.registrationEnabled} label="Take registrations" description="Members sign up on the event page." />
            <Field label={`Opens (${zone})`} htmlFor="registrationOpensAt" hint="Blank opens it right away">
              <Input id="registrationOpensAt" name="registrationOpensAt" type="datetime-local" defaultValue={dateToZonedValue(event.registrationOpensAt, timezone)} />
            </Field>
            <Field label={`Closes (${zone})`} htmlFor="registrationClosesAt" hint="Blank keeps it open">
              <Input id="registrationClosesAt" name="registrationClosesAt" type="datetime-local" defaultValue={dateToZonedValue(event.registrationClosesAt, timezone)} />
            </Field>
            <Field label="Capacity" htmlFor="registrationMax" hint="Blank means no limit">
              <Input id="registrationMax" name="registrationMax" type="number" min={1} step={1} defaultValue={event.registrationMax ?? ""} placeholder="No limit" />
            </Field>
            <Field label="Fee" htmlFor="registrationFeeCents" hint="Blank means free. A fee makes people pay with Stripe to register.">
              <MoneyInput id="registrationFeeCents" name="registrationFeeCents" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0.00" />
            </Field>
          </FormSection>

          <FormSection title="Waitlist">
            <SwitchField
              name="registrationWaitlistEnabled"
              defaultChecked={event.registrationWaitlistEnabled}
              label="Waitlist when full"
              description="People join a waitlist once the capacity is reached."
            />
            <SwitchField
              name="waitlistAutoPromote"
              checked={!isPaid && autoPromote}
              onCheckedChange={setAutoPromote}
              disabled={isPaid}
              label="Move people up automatically"
              description={isPaid ? "Paid events: promote people by hand, since they haven't paid yet." : "When a spot opens, the next person on the waitlist gets it."}
            />
            {/* A disabled switch isn't submitted; keep the saved setting for if the event goes free again */}
            {isPaid && autoPromote && <input type="hidden" name="waitlistAutoPromote" value="on" />}
          </FormSection>

          {error && (
            <Notice tone="danger" title="Not saved">
              {error}
            </Notice>
          )}
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
