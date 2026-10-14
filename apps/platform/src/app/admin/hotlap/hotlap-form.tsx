"use client"

import { toast } from "sonner"
import type { HotlapSettings } from "@/lib/email/settings"
import { useFormAction } from "@/components/admin/use-form-action"
import { Badge, Button, Field, FieldGrid, FormActions, FormSection, Input, Notice, Panel, PanelBody, PanelFooter, PanelHeader } from "@/components/admin/kit"
import { updateHotlapSettings } from "./actions"
import { VideoField } from "./video-field"

export default function HotlapForm({ initial, showing }: { initial: HotlapSettings | null; showing: boolean }) {
  const { onSubmit, error, pending } = useFormAction(updateHotlapSettings, () => toast.success("Hotlap saved"))

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2">
              Hotlap of the week
              {showing && <Badge tone="success">On the home page</Badge>}
            </span>
          }
        />
        <PanelBody className="flex flex-col gap-6">
          {!initial && <Notice tone="info">Nothing saved yet, so the home page shows its built-in hotlap until you save one.</Notice>}
          <FormSection title="Video">
            <VideoField name="videoUrl" defaultValue={initial?.videoUrl} defaultKind="youtube" />
          </FormSection>
          <FormSection title="The lap">
            <FieldGrid>
              <Field label="Driver" htmlFor="driverName" required>
                <Input id="driverName" name="driverName" required defaultValue={initial?.driverName ?? ""} placeholder="Bryan Reyes" />
              </Field>
              <Field label="Lap time" htmlFor="lapTime" required>
                <Input id="lapTime" name="lapTime" required defaultValue={initial?.lapTime ?? ""} placeholder="1:46.043" className="tabular-nums" />
              </Field>
              <Field label="Car" htmlFor="car" required>
                <Input id="car" name="car" required defaultValue={initial?.car ?? ""} placeholder="GT-M Hyperion V8 (GT3)" />
              </Field>
              <Field label="Track" htmlFor="track" required>
                <Input id="track" name="track" required defaultValue={initial?.track ?? ""} placeholder="Daytona International" />
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
            note={showing ? "Shows on the home page as soon as you save." : "The home page shows the competition clip until you switch back above."}
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
