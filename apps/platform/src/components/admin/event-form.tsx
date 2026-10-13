"use client"

import { useState } from "react"
import type { Event, EventSeries, Venue } from "@prisma/client"
import {
  Button,
  Field,
  FieldGrid,
  FormSection,
  Input,
  MoneyInput,
  Notice,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Select,
  SwitchField,
  Textarea,
} from "@/components/admin/kit"
import { ImageUploader } from "@/components/image-uploader"
import { createEvent, updateEvent } from "@/app/admin/events/actions"
import { getEffectiveEventStatus, isEventPublic } from "@/lib/events"
import { DEFAULT_TIMEZONE, TIMEZONES, dateToZonedValue } from "@/lib/dates"
import { centsToDollarInput } from "@/lib/money"
import { EVENT_STATUS, EventStatusBadge } from "@/app/admin/events/_components/event-status"
import { useFormAction } from "./use-form-action"

const slugFrom = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** A datetime-local input in the form's time zone. Re-keyed when the zone changes so it re-reads its value. */
function ZonedInput({ name, label, value, timezone, required, hint }: { name: string; label: string; value: Date | null | undefined; timezone: string; required?: boolean; hint?: string }) {
  return (
    <Field label={label} htmlFor={name} required={required} hint={hint}>
      <Input id={name} name={name} type="datetime-local" key={`${name}-${timezone}`} defaultValue={dateToZonedValue(value, timezone)} required={required} />
    </Field>
  )
}

export function EventForm({ event, series, venues }: { event?: Event; series: EventSeries[]; venues: Venue[] }) {
  const [timezone, setTimezone] = useState<string>(event?.timezone || DEFAULT_TIMEZONE)
  const [slug, setSlug] = useState(event?.slug ?? "")
  const [slugTouched, setSlugTouched] = useState(!!event)
  const { onSubmit, error, pending } = useFormAction((formData) => (event ? updateEvent(event.id, formData) : createEvent(formData)))

  const zoneName = TIMEZONES.find((tz) => tz.value === timezone)?.label ?? timezone
  const effective = event ? getEffectiveEventStatus(event) : null
  const isPublic = event ? isEventPublic(event) : false

  return (
    <form
      onSubmit={onSubmit}
      // Enter would submit with the first button and could change the status; make people pick a button
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault()
      }}
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"
    >
      <input type="hidden" name="timezone" value={timezone} />

      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Details" />
          <PanelBody>
            <FieldGrid>
              <Field label="Title" htmlFor="title" required>
                <Input
                  id="title"
                  name="title"
                  defaultValue={event?.title}
                  required
                  maxLength={200}
                  placeholder="General Meeting 1"
                  onChange={(e) => {
                    if (!slugTouched) setSlug(slugFrom(e.target.value))
                  }}
                />
              </Field>
              <Field label="URL slug" htmlFor="slug" required hint={`The public page is /events/${slug || "…"}`}>
                <Input
                  id="slug"
                  name="slug"
                  value={slug}
                  required
                  placeholder="general-meeting-1"
                  onChange={(e) => {
                    setSlugTouched(true)
                    setSlug(e.target.value)
                  }}
                />
              </Field>
              <Field label="Series" htmlFor="seriesId">
                <Select id="seriesId" name="seriesId" defaultValue={event?.seriesId ?? ""}>
                  <option value="">None</option>
                  {series.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Venue" htmlFor="venueId">
                <Select id="venueId" name="venueId" defaultValue={event?.venueId ?? ""}>
                  <option value="">None</option>
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FieldGrid>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="When" description={`Every time on this page is in ${zoneName}.`} />
          <PanelBody>
            <FieldGrid>
              <Field label="Time zone" htmlFor="timezone-select" className="sm:col-span-2" hint="Changing it shows the saved times in the new zone.">
                <Select id="timezone-select" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="sm:max-w-sm">
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <ZonedInput name="startsAtUtc" label="Starts" value={event?.startsAtUtc} timezone={timezone} required />
              <ZonedInput name="endsAtUtc" label="Ends" value={event?.endsAtUtc} timezone={timezone} required />
            </FieldGrid>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Content" />
          <PanelBody className="flex flex-col gap-3">
            <Field label="Summary" htmlFor="summary" hint="One or two sentences. Shown on the event page and in link previews.">
              <Textarea id="summary" name="summary" rows={2} defaultValue={event?.summary ?? ""} />
            </Field>
            <Field label="Internal notes" htmlFor="description" hint="Only officers see this.">
              <Textarea id="description" name="description" rows={3} defaultValue={event?.description ?? ""} />
            </Field>
            <Field label="Hero image" hint="Shown at the top of the event page.">
              <ImageUploader name="heroImageUrl" defaultValue={event?.heroImageUrl} />
            </Field>
            <Field label="Stream link" htmlFor="streamUrl" hint="Plays on the event page while it's live.">
              <Input id="streamUrl" name="streamUrl" type="url" defaultValue={event?.streamUrl ?? ""} placeholder="https://twitch.tv/…" />
            </Field>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Registration" description="Fine-tune it later from the event's registration tab." />
          <PanelBody className="flex flex-col gap-4">
            <FormSection title="Sign-ups">
              <SwitchField name="registrationEnabled" defaultChecked={event?.registrationEnabled ?? false} label="Take registrations" description="Members sign up on the event page." />
              <SwitchField
                name="registrationWaitlistEnabled"
                defaultChecked={event?.registrationWaitlistEnabled ?? false}
                label="Waitlist when full"
                description="People join a waitlist once the capacity is reached."
              />
            </FormSection>
            <FieldGrid>
              <ZonedInput name="registrationOpensAt" label="Opens" value={event?.registrationOpensAt} timezone={timezone} hint="Blank opens it right away" />
              <ZonedInput name="registrationClosesAt" label="Closes" value={event?.registrationClosesAt} timezone={timezone} hint="Blank keeps it open" />
              <Field label="Capacity" htmlFor="registrationMax" hint="Blank means no limit">
                <Input id="registrationMax" name="registrationMax" type="number" min={1} step={1} defaultValue={event?.registrationMax ?? ""} placeholder="No limit" />
              </Field>
              <Field label="Fee" htmlFor="registrationFeeCents" hint="Blank means free. A fee makes people pay with Stripe to register.">
                <MoneyInput id="registrationFeeCents" name="registrationFeeCents" defaultValue={centsToDollarInput(event?.registrationFeeCents || null)} placeholder="0.00" />
              </Field>
            </FieldGrid>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Check-in" />
          <PanelBody className="flex flex-col gap-4">
            <SwitchField
              name="attendanceEnabled"
              defaultChecked={event?.attendanceEnabled ?? false}
              label="Check people in"
              description="Members scan a QR code at the event. Off: everyone registered counts as attended."
            />
            <FieldGrid>
              <ZonedInput name="attendanceOpensAt" label="Check-in opens" value={event?.attendanceOpensAt} timezone={timezone} />
              <ZonedInput name="attendanceClosesAt" label="Check-in closes" value={event?.attendanceClosesAt} timezone={timezone} />
            </FieldGrid>
          </PanelBody>
        </Panel>
      </div>

      <Panel className="lg:sticky lg:top-[60px]">
        <PanelHeader
          title="Publish"
          description={
            event && effective ? (
              <span className="flex flex-wrap items-center gap-1.5">
                Now <EventStatusBadge status={effective} />
              </span>
            ) : (
              "New events stay hidden until you publish them."
            )
          }
        />
        <PanelBody className="flex flex-col gap-3">
          {event && effective && (
            <p className="text-xs text-muted-foreground">
              {EVENT_STATUS[effective].meaning} Save changes keeps this status; the other buttons change it.
            </p>
          )}
          <Field label="Publish at" htmlFor="scheduleDate" hint="For Schedule: the event goes public at this time.">
            <Input
              type="datetime-local"
              name="scheduleDate"
              id="scheduleDate"
              key={`scheduleDate-${timezone}`}
              defaultValue={event?.publishedAt ? dateToZonedValue(event.publishedAt, timezone) : ""}
            />
          </Field>
          {error && (
            <Notice tone="danger" title="Not saved">
              {error}
            </Notice>
          )}
        </PanelBody>
        <PanelFooter className="flex-col items-stretch">
          {event && (
            // No submitAction: the action leaves the status (and publish time) as they are
            <Button type="submit" variant="primary" pending={pending}>
              Save changes
            </Button>
          )}
          <Button type="submit" name="submitAction" value="publish" variant={event ? "secondary" : "primary"} pending={!event && pending} disabled={pending}>
            Publish now
          </Button>
          <Button type="submit" name="submitAction" value="schedule" disabled={pending}>
            Schedule
          </Button>
          <Button type="submit" name="submitAction" value="draft" disabled={pending}>
            {isPublic ? "Unpublish to a draft" : "Save as draft"}
          </Button>
        </PanelFooter>
      </Panel>
    </form>
  )
}
