"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button, Field, Input, RowMenu, Textarea, useConfirm } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { MEETING_LIMITS } from "@/lib/meetings"
import { addMeetingDecision, removeMeeting, removeMeetingDecision } from "../actions"

async function run<T>(action: () => Promise<ActionResult<T>>, what: string): Promise<ActionResult<T>> {
  try {
    const result = await action()
    if (!result.ok) toast.error(result.error)
    return result
  } catch (error) {
    const message = unexpectedError(error, what)
    toast.error(message)
    return { ok: false, error: message }
  }
}

/** Adds a decision to the meeting (and the decision log) */
export function AddDecisionForm({ meetingId }: { meetingId: string }) {
  const router = useRouter()
  const [text, setText] = useState("")
  const [title, setTitle] = useState("")
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const result = await run(() => addMeetingDecision(meetingId, { text, title }), "Couldn't add the decision")
    setSaving(false)
    if (!result.ok) return
    if (result.data.logged) toast.success("Decision added, and saved to the decision log")
    else toast.warning(`Decision added, but not to the decision log: ${result.data.note ?? "it couldn't be saved"}`)
    setText("")
    setTitle("")
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
      <Field label="Decision" htmlFor="decision-text" hint="One plain sentence, in the meeting's words.">
        <Textarea id="decision-text" rows={2} value={text} maxLength={MEETING_LIMITS.decisionMax} onChange={(event) => setText(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Short title" htmlFor="decision-title" hint="For the decision log; made from the text when left blank." className="min-w-48 flex-1">
          <Input id="decision-title" value={title} maxLength={MEETING_LIMITS.decisionTitleMax} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Button type="submit" pending={saving} disabled={text.trim().length < 3}>
          Add decision
        </Button>
      </div>
    </form>
  )
}

/** A decision's menu: remove it from the meeting (its decision-log entry stays) */
export function DecisionMenu({ decisionId }: { decisionId: string }) {
  const router = useRouter()
  return (
    <RowMenu
      label="Decision options"
      items={[
        {
          label: "Remove from the meeting",
          destructive: {
            title: "Remove this decision?",
            description: "It comes off the meeting. Its entry in the decision log (Knowledge) stays: archive it there if the decision is wrong.",
            confirmLabel: "Remove",
          },
          onSelect: async () => {
            const result = await run(() => removeMeetingDecision(decisionId), "Couldn't remove it")
            if (!result.ok) return
            toast.success("Removed")
            router.refresh()
          },
        },
      ]}
    />
  )
}

/** Deletes a meeting and its decisions; its action items and decision-log entries stay */
export function DeleteMeetingButton({ id, title }: { id: string; title: string }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, setPending] = useState(false)

  async function remove() {
    const ok = await confirm({
      title: `Delete “${title}”?`,
      description: "The meeting, its agenda, summary and decisions are deleted. Its action items stay on the Action items page, and its decisions stay in the decision log (archive them in Knowledge if they're wrong).",
      confirmLabel: "Delete",
      tone: "danger",
    })
    if (!ok) return
    setPending(true)
    const result = await run(() => removeMeeting(id), "Couldn't delete it")
    setPending(false)
    if (!result.ok) return
    toast.success("Meeting deleted")
    router.replace("/admin/meetings")
  }

  return (
    <Button variant="danger" pending={pending} onClick={() => void remove()}>
      <Trash2 aria-hidden />
      Delete
    </Button>
  )
}

/** How long "Copied" shows before the button goes back */
const COPIED_MS = 2_000

/** Copies a meeting's agenda as plain text */
export function CopyAgendaButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      toast.error("Couldn't reach the clipboard. Select the agenda and copy it instead.")
    }
  }

  return (
    <Button variant="primary" onClick={() => void copy()}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : "Copy as text"}
    </Button>
  )
}
