"use client"

import { toast } from "sonner"
import type { ClipSettings } from "@/lib/email/settings"
import { useFormAction } from "@/components/admin/use-form-action"
import { Badge, Button, Field, FieldGrid, FormActions, FormSection, Input, Notice, Panel, PanelBody, PanelFooter, PanelHeader } from "@/components/admin/kit"
import { updateClipSettings } from "./actions"
import { VideoField } from "./video-field"

export default function ClipForm({ initial, showing }: { initial: ClipSettings | null; showing: boolean }) {
  const { onSubmit, error, pending } = useFormAction(updateClipSettings, () => toast.success("Clip saved"))

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2">
              Competition clip
              {showing && <Badge tone="success">On the home page</Badge>}
            </span>
          }
          description="A highlight from a race: an overtake, a save, a photo finish."
        />
        <PanelBody className="flex flex-col gap-6">
          <FormSection title="Video">
            <VideoField name="videoUrl" defaultValue={initial?.videoUrl} defaultKind="upload" />
          </FormSection>
          <FormSection title="The clip">
            <Field label="Title" htmlFor="clip-title" required hint="What happens, in a few words.">
              <Input id="clip-title" name="title" required maxLength={80} defaultValue={initial?.title ?? ""} placeholder="Last-lap switchback" />
            </Field>
            <FieldGrid>
              <Field label="Drivers" htmlFor="clip-drivers" hint="Who's in it.">
                <Input id="clip-drivers" name="drivers" maxLength={120} defaultValue={initial?.drivers ?? ""} />
              </Field>
              <Field label="Race" htmlFor="clip-race">
                <Input id="clip-race" name="race" maxLength={120} defaultValue={initial?.race ?? ""} placeholder="Lone Star Cup, Round 4 at Brands Hatch" />
              </Field>
              <Field label="Clip by" htmlFor="clip-credit" hint="Who recorded or edited it, for the credit.">
                <Input id="clip-credit" name="credit" maxLength={120} defaultValue={initial?.credit ?? ""} />
              </Field>
            </FieldGrid>
          </FormSection>
          {error && (
            <Notice tone="danger" title="Not saved">
              {error}
            </Notice>
          )}
        </PanelBody>
        <PanelFooter>
          <FormActions
            className="w-full"
            note={showing ? "Shows on the home page as soon as you save." : "Saves it for later. Switch to Competition clip above to show it on the home page."}
          >
            <Button type="submit" variant="primary" pending={pending}>
              Save
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
