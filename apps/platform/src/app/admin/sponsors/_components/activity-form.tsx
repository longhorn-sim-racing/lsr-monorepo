"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button, Field, FieldGrid, Input, RowMenu, Select, Textarea, useConfirm } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { ACTIVITY_LABEL, ACTIVITY_TYPES, PROSPECT_STAGE_LABEL, PROSPECT_STAGES, type ProspectStage } from "@/lib/sponsor-prospects"
import { PROSPECT_LIMITS } from "@/schemas/sponsor-prospect.schema"
import { logActivity, removeActivity, removeProspect } from "../actions"

async function run(action: () => Promise<ActionResult>, what: string): Promise<boolean> {
  let result: ActionResult
  try {
    result = await action()
  } catch (error) {
    result = { ok: false, error: unexpectedError(error, what) }
  }
  if (!result.ok) toast.error(result.error)
  return result.ok
}

/** Logs an email, reply, call, meeting or note on a prospect, optionally moving its stage */
export function ActivityForm({ prospectId, stage, today }: { prospectId: string; stage: string; today: string }) {
  const router = useRouter()
  const [type, setType] = useState<string>("email_sent")
  const [date, setDate] = useState(today)
  const [summary, setSummary] = useState("")
  const [moveTo, setMoveTo] = useState("")
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const ok = await run(() => logActivity(prospectId, { type, summary, date, stage: moveTo }), "Couldn't log it")
    setSaving(false)
    if (!ok) return
    toast.success("Logged")
    setSummary("")
    setMoveTo("")
    router.refresh()
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <FieldGrid>
        <Field label="What" htmlFor="activity-type">
          <Select id="activity-type" value={type} onChange={(event) => setType(event.target.value)}>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="When" htmlFor="activity-date">
          <Input id="activity-date" type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} />
        </Field>
      </FieldGrid>
      <Field label="What happened" htmlFor="activity-summary" required>
        <Textarea id="activity-summary" rows={3} value={summary} maxLength={PROSPECT_LIMITS.activityMax} onChange={(event) => setSummary(event.target.value)} placeholder="e.g. Sent the sponsor packet to their marketing team" />
      </Field>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Move to stage" htmlFor="activity-stage" className="min-w-48 flex-1">
          <Select id="activity-stage" value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
            <option value="">Keep: {PROSPECT_STAGE_LABEL[stage as ProspectStage] ?? stage}</option>
            {PROSPECT_STAGES.filter((s) => s !== stage).map((s) => (
              <option key={s} value={s}>
                {PROSPECT_STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" pending={saving} disabled={!summary.trim()}>
          Log it
        </Button>
      </div>
    </form>
  )
}

/** A logged activity's menu: remove it (a mistake). Stage changes stay */
export function ActivityMenu({ activityId, label }: { activityId: string; label: string }) {
  const router = useRouter()
  return (
    <RowMenu
      label={`Options for ${label}`}
      items={[
        {
          label: "Remove",
          destructive: { title: "Remove this activity?", description: "It comes off the prospect's timeline. The audit log keeps a note that it was removed.", confirmLabel: "Remove" },
          onSelect: async () => {
            if (await run(() => removeActivity(activityId), "Couldn't remove it")) {
              toast.success("Removed")
              router.refresh()
            }
          },
        },
      ]}
    />
  )
}

/** Deletes a prospect and its activity for good */
export function DeleteProspectButton({ id, company }: { id: string; company: string }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, setPending] = useState(false)

  async function remove() {
    const ok = await confirm({
      title: `Delete ${company}?`,
      description: "The prospect, its contact details and its whole activity log are deleted for good. The audit log keeps only the company's name. To keep the history, set the stage to Declined or Dormant instead.",
      confirmLabel: "Delete for good",
      tone: "danger",
    })
    if (!ok) return
    setPending(true)
    const done = await run(() => removeProspect(id), "Couldn't delete it")
    setPending(false)
    if (!done) return
    toast.success("Prospect deleted")
    router.replace("/admin/sponsors")
  }

  return (
    <Button variant="danger" pending={pending} onClick={() => void remove()}>
      <Trash2 aria-hidden />
      Delete
    </Button>
  )
}
