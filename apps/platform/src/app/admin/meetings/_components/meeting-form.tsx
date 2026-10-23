"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button, Field, FieldGrid, FormActions, Input, Panel, PanelBody, PanelFooter, Select, Textarea } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { MEETING_LIMITS, MEETING_TYPE_LABEL, MEETING_TYPES, meetingPath } from "@/lib/meetings"
import { saveMeeting, type MeetingFormInput, type SaveMeetingResult } from "../actions"

const MARKDOWN_HINT = "Markdown: - bullet, 1. numbered, **bold**, [link](https://…)"

/** The fields an edit sends: only what changed (the date and time go together) */
function changedFields(form: MeetingFormInput, initial: MeetingFormInput): Partial<MeetingFormInput> {
  const changed: Partial<MeetingFormInput> = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== initial[key as keyof MeetingFormInput]))
  if (changed.date !== undefined || changed.time !== undefined) return { ...changed, date: form.date, time: form.time }
  return changed
}

/** Records a meeting, or edits one (sending only what changed) */
export function MeetingForm({ id, initial, compact = false }: { id: string | null; initial: MeetingFormInput; compact?: boolean }) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const set = (key: keyof MeetingFormInput) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: event.target.value }))

  async function save() {
    setSaving(true)
    let result: SaveMeetingResult
    try {
      result = await saveMeeting(id, id ? changedFields(form, initial) : form)
    } catch (error) {
      result = { ok: false, error: unexpectedError(error, "Couldn't save the meeting") }
    } finally {
      setSaving(false)
    }
    if (!result.ok) return toast.error(result.error)
    toast.success(id ? "Saved" : "Meeting recorded")
    if (!id) router.replace(meetingPath(result.id))
    else router.refresh()
  }

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Panel>
        <PanelBody className="flex flex-col gap-4">
          <FieldGrid className={compact ? "sm:grid-cols-1" : undefined}>
            <Field label="Title" htmlFor="meeting-title" required className={compact ? undefined : "sm:col-span-2"}>
              <Input id="meeting-title" value={form.title} maxLength={MEETING_LIMITS.titleMax} onChange={set("title")} placeholder="e.g. Board meeting" />
            </Field>
            <Field label="Type" htmlFor="meeting-type">
              <Select id="meeting-type" value={form.type} onChange={set("type")}>
                {MEETING_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {MEETING_TYPE_LABEL[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date" htmlFor="meeting-date" required>
                <Input id="meeting-date" type="date" value={form.date} onChange={set("date")} />
              </Field>
              <Field label="Time" htmlFor="meeting-time" hint="Central">
                <Input id="meeting-time" type="time" value={form.time} onChange={set("time")} />
              </Field>
            </div>
          </FieldGrid>
          <Field label="Agenda" htmlFor="meeting-agenda" hint={MARKDOWN_HINT}>
            <Textarea id="meeting-agenda" rows={compact ? 6 : 8} value={form.agendaMd} maxLength={MEETING_LIMITS.textMax} onChange={set("agendaMd")} className="font-mono text-xs" />
          </Field>
          <Field label="Summary" htmlFor="meeting-summary" hint="What was discussed. Decisions and action items have their own lists.">
            <Textarea id="meeting-summary" rows={compact ? 8 : 10} value={form.summaryMd} maxLength={MEETING_LIMITS.textMax} onChange={set("summaryMd")} className="font-mono text-xs" />
          </Field>
        </PanelBody>
        <PanelFooter>
          <FormActions className="w-full">
            <Button type="submit" variant="primary" pending={saving}>
              {id ? "Save" : "Record meeting"}
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
