"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, Dialog, Field, FieldGrid, Input, RowActions, RowMenu, Select, Textarea, type RowMenuItem } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { MEETING_LIMITS } from "@/lib/meetings"
import { cn } from "@/lib/utils"
import { addActionItem, editActionItem, setActionItemStatus, type ActionItemFormInput } from "../actions"

/** An action item as the lists show it (plain values, ready to render) */
export type ActionItemView = {
  id: string
  text: string
  status: "open" | "done" | "dropped"
  ownerId: string | null
  ownerName: string | null
  /** YYYY-MM-DD (Central), for the edit form */
  dueDate: string
  /** "Fri, Oct 30" */
  dueLabel: string | null
  overdueDays: number
  /** "Done Oct 28" */
  doneLabel: string | null
  meeting: { id: string; title: string } | null
}

type Officer = { id: string; displayName: string }

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

/** Action items as a list, each with Done (or Reopen) and a menu: edit, drop */
export function ActionItemList({ items, officers, showMeeting = true, showOwner = false }: { items: ActionItemView[]; officers: Officer[]; showMeeting?: boolean; showOwner?: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState<ActionItemView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function setStatus(item: ActionItemView, status: ActionItemView["status"], done: string) {
    setBusy(item.id)
    const ok = await run(() => setActionItemStatus(item.id, status), "Couldn't change it")
    setBusy(null)
    if (!ok) return
    toast.success(done)
    router.refresh()
  }

  return (
    <>
      <ul className="flex flex-col">
        {items.map((item) => {
          const menu: RowMenuItem[] = [
            { label: "Edit", onSelect: () => setEditing(item) },
            ...(item.status === "open" ? [{ label: "Drop", onSelect: () => setStatus(item, "dropped", "Dropped") }] : [{ label: "Reopen", onSelect: () => setStatus(item, "open", "Reopened") }]),
          ]
          return (
            <li key={item.id} className="flex items-start gap-3 border-b border-admin-row px-4 py-2.5 text-[13px] last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className={cn("whitespace-pre-wrap break-words", item.status !== "open" && "text-muted-foreground line-through decoration-admin-subtle")}>{item.text}</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-admin-subtle">
                  {item.status === "done" ? <Badge tone="success">{item.doneLabel ?? "Done"}</Badge> : item.status === "dropped" ? <Badge>Dropped</Badge> : null}
                  {item.status === "open" && item.overdueDays > 0 && <Badge tone="warning">{item.overdueDays === 1 ? "1 day" : `${item.overdueDays} days`} overdue</Badge>}
                  {item.dueLabel && <span>Due {item.dueLabel}</span>}
                  {showOwner && <span>{item.ownerName ?? "No owner"}</span>}
                  {showMeeting && item.meeting && (
                    <Link href={`/admin/meetings/${item.meeting.id}`} className="hover:text-foreground hover:underline">
                      {item.meeting.title}
                    </Link>
                  )}
                </div>
              </div>
              <RowActions>
                {item.status === "open" ? (
                  <Button size="sm" pending={busy === item.id} onClick={() => void setStatus(item, "done", "Marked done")}>
                    <Check aria-hidden />
                    Done
                  </Button>
                ) : null}
                <RowMenu label={`Options for “${item.text.slice(0, 40)}”`} items={menu} />
              </RowActions>
            </li>
          )
        })}
      </ul>
      {editing && <EditDialog item={editing} officers={officers} onClose={() => setEditing(null)} />}
    </>
  )
}

function EditDialog({ item, officers, onClose }: { item: ActionItemView; officers: Officer[]; onClose: () => void }) {
  const router = useRouter()
  const initial: ActionItemFormInput = { text: item.text, ownerId: item.ownerId ?? "", due: item.dueDate }
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  // A former officer who still owns it stays in the list, so saving doesn't drop them by accident
  const owners = item.ownerId && !officers.some((o) => o.id === item.ownerId) ? [...officers, { id: item.ownerId, displayName: item.ownerName ?? "Former officer" }] : officers

  async function save() {
    const changed = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== initial[key as keyof ActionItemFormInput]))
    if (!Object.keys(changed).length) return onClose()
    setSaving(true)
    const ok = await run(() => editActionItem(item.id, changed), "Couldn't save it")
    setSaving(false)
    if (!ok) return
    toast.success("Saved")
    onClose()
    router.refresh()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit action item"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <ActionItemFields form={form} setForm={setForm} officers={owners} idPrefix="edit-item" />
    </Dialog>
  )
}

function ActionItemFields({ form, setForm, officers, idPrefix }: { form: ActionItemFormInput; setForm: React.Dispatch<React.SetStateAction<ActionItemFormInput>>; officers: Officer[]; idPrefix: string }) {
  const set = (key: keyof ActionItemFormInput) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: event.target.value }))
  return (
    <div className="flex flex-col gap-3">
      <Field label="What needs doing" htmlFor={`${idPrefix}-text`} required>
        <Textarea id={`${idPrefix}-text`} rows={2} value={form.text} maxLength={MEETING_LIMITS.actionItemMax} onChange={set("text")} />
      </Field>
      <FieldGrid>
        <Field label="Owner" htmlFor={`${idPrefix}-owner`}>
          <Select id={`${idPrefix}-owner`} value={form.ownerId} onChange={set("ownerId")}>
            <option value="">No owner</option>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due" htmlFor={`${idPrefix}-due`}>
          <Input id={`${idPrefix}-due`} type="date" value={form.due} onChange={set("due")} />
        </Field>
      </FieldGrid>
    </div>
  )
}

/** Adds an action item (on a meeting, when one is given) */
export function AddActionItemForm({ officers, meetingId }: { officers: Officer[]; meetingId?: string }) {
  const router = useRouter()
  const empty: ActionItemFormInput = { text: "", ownerId: "", due: "" }
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const ok = await run(() => addActionItem(form, meetingId), "Couldn't add it")
    setSaving(false)
    if (!ok) return
    toast.success("Action item added")
    setForm(empty)
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
      <ActionItemFields form={form} setForm={setForm} officers={officers} idPrefix={meetingId ? "meeting-item" : "new-item"} />
      <div className="flex justify-end">
        <Button type="submit" variant={meetingId ? "secondary" : "primary"} pending={saving} disabled={form.text.trim().length < 3}>
          Add action item
        </Button>
      </div>
    </form>
  )
}
