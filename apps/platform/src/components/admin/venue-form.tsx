"use client"

import Link from "next/link"
import type { Venue } from "@prisma/client"
import { Button, Field, FieldGrid, FormActions, FormSection, Input, Panel, PanelBody, PanelFooter } from "@/components/admin/kit"
import { createVenue, updateVenue } from "@/app/admin/venues/actions"
import { useAction } from "@/app/admin/events/_components/use-action"

function TextField({ name, label, value, placeholder, required, hint, className }: { name: keyof Venue; label: string; value?: string | null; placeholder?: string; required?: boolean; hint?: string; className?: string }) {
  return (
    <Field label={label} htmlFor={name} required={required} hint={hint} className={className}>
      <Input id={name} name={name} defaultValue={value ?? ""} placeholder={placeholder} required={required} />
    </Field>
  )
}

export function VenueForm({ venue }: { venue?: Venue }) {
  const { run, pending } = useAction()

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    // Both actions go back to the list when they finish
    run(() => (venue ? updateVenue(venue.id, formData) : createVenue(formData)), {
      success: venue ? "Venue saved" : "Venue created",
      error: "Couldn't save the venue",
    })
  }

  return (
    <form onSubmit={onSubmit} className="max-w-3xl">
      <Panel>
        <PanelBody className="flex flex-col gap-6">
          <FormSection title="Venue">
            <FieldGrid>
              <TextField name="name" label="Name" value={venue?.name} placeholder="Gates Dell Complex" required />
              <TextField name="room" label="Room" value={venue?.room} placeholder="GDC 2.216" hint="Optional" />
            </FieldGrid>
          </FormSection>

          <FormSection title="Address">
            <FieldGrid>
              <TextField name="addressLine1" label="Street address" value={venue?.addressLine1} placeholder="2317 Speedway" className="sm:col-span-2" />
              <TextField name="addressLine2" label="Address line 2" value={venue?.addressLine2} className="sm:col-span-2" />
              <TextField name="city" label="City" value={venue?.city} placeholder="Austin" />
              <TextField name="state" label="State" value={venue?.state} placeholder="TX" />
              <TextField name="postalCode" label="Postal code" value={venue?.postalCode} placeholder="78712" />
              <TextField name="country" label="Country" value={venue?.country} placeholder="USA" />
            </FieldGrid>
          </FormSection>

          <FormSection title="Map links" description="Shown on the event page so people can get directions.">
            <FieldGrid>
              <TextField name="googleMapsUrl" label="Google Maps" value={venue?.googleMapsUrl} placeholder="https://maps.google.com/…" />
              <TextField name="appleMapsUrl" label="Apple Maps" value={venue?.appleMapsUrl} placeholder="https://maps.apple.com/…" />
            </FieldGrid>
          </FormSection>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full">
            <Button asChild variant="ghost">
              <Link href="/admin/venues">Cancel</Link>
            </Button>
            <Button type="submit" variant="primary" pending={pending}>
              {venue ? "Save venue" : "Create venue"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
