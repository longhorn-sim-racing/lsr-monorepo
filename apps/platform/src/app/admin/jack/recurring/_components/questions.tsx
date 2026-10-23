"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { Badge, Button, CheckboxField, Dialog, EmptyState, Field, FieldGrid, Input, Notice, RowActions, RowMenu, Select, SwitchField, Textarea, type RowMenuItem, type Tone } from "@/components/admin/kit"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { clockLabel, RECURRING_LIMITS, WEEKDAY_LABEL, WEEKDAYS, type RecurringPersona, type RecurringSchedule, type ScheduleEvery, type Weekday } from "@/lib/jack/recurring"
import { formatUsd } from "@/lib/jack/spend"
import { cn } from "@/lib/utils"
import {
  askRecurringQuestionNowAction,
  createRecurringQuestionAction,
  deleteRecurringQuestionAction,
  setRecurringQuestionOnAction,
  updateRecurringQuestionAction,
  type RecurringFormInput,
} from "../actions"

/** A recurring question as the page lists it (plain values, ready to render) */
export type QuestionView = {
  id: string
  title: string
  prompt: string
  persona: RecurringPersona
  roomId: string
  roomTitle: string
  roomArchived: boolean
  owner: { id: string; name: string; officer: boolean } | null
  schedule: RecurringSchedule | null
  scheduleText: string
  enabled: boolean
  pausedReason: string | null
  /** "Mon, Oct 26, 9:00 AM CT (in 3 days)" while it's on */
  nextRun: string | null
  lastAsked: string | null
  estimate: { monthlyUsd: number; perRunUsd: number; runs: number; basis: "own" | "recent" | "typical" }
  monthUsd: number
  runs: {
    id: string
    at: string
    status: string
    summary: string | null
    reply: { href: string; costUsd: number | null; status: string } | null
    waiting: { href: string } | null
  }[]
}

export type RoomChoice = { id: string; title: string }

const PERSONA: Record<RecurringPersona, { label: string; hint: string }> = {
  jack: { label: "Jack", hint: "Sonnet: most questions" },
  stand: { label: "Stand", hint: "Haiku: cheaper, for simple counts and lists" },
}

const EVERY: Record<ScheduleEvery, string> = { day: "Every day", weekday: "Weekdays (Monday to Friday)", week: "On some days of the week", month: "Once a month" }

const RUN_TONE: Record<string, Tone> = { ok: "success", error: "danger", skipped: "neutral", running: "info" }
const RUN_LABEL: Record<string, string> = { ok: "Asked", error: "Failed", skipped: "Skipped", running: "Running" }

async function run<T>(action: () => Promise<ActionResult<T>>, what: string): Promise<ActionResult<T>> {
  try {
    const result = await action()
    if (!result.ok) toast.error(result.error)
    return result
  } catch (error) {
    const result = { ok: false as const, error: unexpectedError(error, what) }
    toast.error(result.error)
    return result
  }
}

/** "New question": the form in a dialog */
export function NewQuestionButton({ rooms }: { rooms: RoomChoice[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        New question
      </Button>
      {open ? <QuestionDialog rooms={rooms} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** The questions, each with its switch, menu (edit, ask now, delete) and last runs */
export function QuestionList({ questions, rooms, highlight, viewerId }: { questions: QuestionView[]; rooms: RoomChoice[]; highlight: string | null; viewerId: string | null }) {
  const router = useRouter()
  const [editing, setEditing] = useState<QuestionView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const highlighted = useRef<HTMLLIElement>(null)

  useEffect(() => {
    highlighted.current?.scrollIntoView({ block: "center" })
  }, [highlight])

  if (!questions.length) {
    return <EmptyState title="No recurring questions yet" description="Set one up here, or ask Jack in a room (“every Monday at 9, tell us how many people signed up last week”); he proposes it for an officer to apply." />
  }

  async function toggle(question: QuestionView) {
    setBusy(question.id)
    const result = await run(() => setRecurringQuestionOnAction(question.id, !question.enabled), "Couldn't switch it")
    setBusy(null)
    if (!result.ok) return
    toast.success(question.enabled ? "Turned off" : result.data.tookOver ? "Turned on, and it runs as you from now on" : "Turned on")
    router.refresh()
  }

  return (
    <>
      <ul>
        {questions.map((question) => {
          const menu: RowMenuItem[] = [
            { label: "Edit", onSelect: () => setEditing(question) },
            {
              label: "Ask now",
              disabled: !question.enabled,
              onSelect: async () => {
                const result = await run(() => askRecurringQuestionNowAction(question.id), "Couldn't ask it")
                if (!result.ok) return
                toast.success("It's asked at the next minute")
                router.refresh()
              },
            },
            "separator",
            {
              label: "Delete",
              destructive: { title: `Delete “${question.title}”?`, description: "Its schedule goes with it. What it already asked and the answers stay in the room.", confirmLabel: "Delete" },
              onSelect: async () => {
                const result = await run(() => deleteRecurringQuestionAction(question.id), "Couldn't delete it")
                if (!result.ok) return
                toast.success("Deleted")
                router.refresh()
              },
            },
          ]
          const paused = !question.enabled && question.pausedReason
          const takesOver = !question.owner?.officer
          return (
            <li
              key={question.id}
              id={`question-${question.id}`}
              ref={question.id === highlight ? highlighted : undefined}
              className={cn("flex items-start gap-3 border-b border-admin-row px-4 py-3 text-[13px] last:border-b-0", question.id === highlight && "bg-admin-selected")}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-semibold">{question.title}</span>
                  <Badge tone={question.enabled ? "success" : paused ? "warning" : "neutral"}>{question.enabled ? "On" : paused ? "Paused" : "Off"}</Badge>
                  <Badge>{PERSONA[question.persona].label}</Badge>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">{question.prompt}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-admin-subtle">
                  <span>{question.scheduleText}</span>
                  <Link href={`/admin/jack/${question.roomId}`} className="hover:text-foreground hover:underline">
                    in “{question.roomTitle}”{question.roomArchived ? " (archived)" : ""}
                  </Link>
                  <span>as {question.owner ? question.owner.name : "a former officer"}</span>
                  {question.nextRun ? <span>Next: {question.nextRun}</span> : null}
                  {question.lastAsked ? <span>Last asked {question.lastAsked}</span> : null}
                  <span title={`${question.estimate.runs} runs a month at about ${formatUsd(question.estimate.perRunUsd)} each (${question.estimate.basis === "own" ? "from its last answers" : question.estimate.basis === "recent" ? "from recent recurring answers" : "a typical run"})`}>
                    About {formatUsd(question.estimate.monthlyUsd)} a month
                  </span>
                  {question.monthUsd > 0 ? <span>{formatUsd(question.monthUsd)} this month</span> : null}
                </div>
                {paused ? (
                  <Notice tone="warning" className="py-2">
                    Paused: {question.pausedReason}.{takesOver ? " Turning it back on makes you its owner: it's asked as you." : ""}
                  </Notice>
                ) : !question.enabled && takesOver ? (
                  <p className="text-xs text-admin-subtle">Its owner isn&apos;t an officer any more: turning it on makes you its owner.</p>
                ) : null}
                {question.runs.length ? (
                  <details className="group">
                    <summary className="cursor-pointer select-none text-xs font-semibold text-muted-foreground hover:text-foreground">Last runs ({question.runs.length})</summary>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {question.runs.map((r) => (
                        <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <span className="whitespace-nowrap text-admin-subtle">{r.at}</span>
                          <Badge tone={RUN_TONE[r.status] ?? "neutral"}>{RUN_LABEL[r.status] ?? r.status}</Badge>
                          {r.reply ? (
                            <Link href={r.reply.href} className="font-medium text-foreground hover:underline">
                              {r.reply.status === "streaming" ? "Being answered" : r.reply.status === "error" ? "Answer (stopped early)" : "Answer"}
                              {r.reply.costUsd !== null ? ` · ${formatUsd(r.reply.costUsd)}` : ""}
                            </Link>
                          ) : r.waiting ? (
                            <Link href={r.waiting.href} className="font-medium text-foreground hover:underline">
                              Waiting in the room
                            </Link>
                          ) : null}
                          {r.summary && !r.reply ? <span className="min-w-0 break-words text-muted-foreground">{r.summary}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <p className="text-xs text-admin-subtle">Not asked yet.</p>
                )}
              </div>
              <RowActions className="gap-1.5">
                <Button size="sm" pending={busy === question.id} onClick={() => void toggle(question)}>
                  {question.enabled ? "Turn off" : "Turn on"}
                </Button>
                <RowMenu label={`Options for “${question.title}”`} items={menu} />
              </RowActions>
            </li>
          )
        })}
      </ul>
      {editing ? <QuestionDialog rooms={rooms} question={editing} othersQuestion={editing.owner?.id !== viewerId} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

const DEFAULT_SCHEDULE: RecurringSchedule = { every: "week", days: ["mon"], time: "09:00" }

function initialForm(question?: QuestionView, rooms: RoomChoice[] = []): RecurringFormInput {
  const schedule = question?.schedule ?? DEFAULT_SCHEDULE
  return {
    title: question?.title ?? "",
    prompt: question?.prompt ?? "",
    roomId: question?.roomId ?? rooms[0]?.id ?? "",
    persona: question?.persona ?? "jack",
    every: schedule.every,
    days: schedule.days ?? ["mon"],
    dayOfMonth: String(schedule.dayOfMonth ?? 1),
    time: schedule.time.padStart(5, "0"),
    on: false,
  }
}

/** Set up a question, or change one (`othersQuestion`: it's asked as someone else, so changing what it asks takes it over) */
function QuestionDialog({ rooms, question, othersQuestion = false, onClose }: { rooms: RoomChoice[]; question?: QuestionView; othersQuestion?: boolean; onClose: () => void }) {
  const router = useRouter()
  const [form, setForm] = useState<RecurringFormInput>(() => initialForm(question, rooms))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof RecurringFormInput>(key: K, value: RecurringFormInput[K]) => setForm((f) => ({ ...f, [key]: value }))
  // Its own room stays pickable even when it's archived (it's moved by picking another)
  const choices = question && !rooms.some((r) => r.id === question.roomId) ? [{ id: question.roomId, title: `${question.roomTitle} (archived)` }, ...rooms] : rooms
  const id = (name: string) => `${question ? `edit-${question.id}` : "new"}-${name}`

  async function save() {
    setSaving(true)
    setError(null)
    let result: { ok: true; tookOver?: boolean } | { ok: false; error: string }
    try {
      if (question) {
        const updated = await updateRecurringQuestionAction(question.id, form)
        result = updated.ok ? { ok: true, tookOver: updated.data.tookOver } : updated
      } else result = await createRecurringQuestionAction(form)
    } catch (thrown) {
      result = { ok: false, error: unexpectedError(thrown, "Couldn't save it") }
    }
    setSaving(false)
    if (!result.ok) return setError(result.error)
    toast.success(question ? (result.tookOver ? "Saved: it's yours now, and it's asked as you" : "Saved") : form.on ? "Set up and on" : "Set up (off): turn it on when it's ready")
    onClose()
    router.refresh()
  }

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={question ? "Edit recurring question" : "New recurring question"}
      description="Asked in its room on a schedule, as the officer who set it up. Jack answers with no web search and doesn't save knowledge from it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} onClick={() => void save()}>
            {question ? "Save" : "Set it up"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Notice tone="danger" className="py-2">
            {error}
          </Notice>
        ) : null}
        {question && othersQuestion ? (
          <Notice tone="info" className="py-2">
            It&apos;s asked as {question.owner?.name ?? "a former officer"}. Changing the question, the room or who answers makes you its owner: it&apos;s asked as you from then on.
          </Notice>
        ) : null}
        <FieldGrid>
          <Field label="Title" htmlFor={id("title")} required hint="A short name, e.g. Weekly signups">
            <Input id={id("title")} value={form.title} maxLength={RECURRING_LIMITS.titleMax} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Room" htmlFor={id("room")} required hint="Where it's asked and answered">
            <Select id={id("room")} value={form.roomId} onChange={(e) => set("roomId", e.target.value)}>
              {choices.length ? null : <option value="">No rooms yet: open one on Jack first</option>}
              {choices.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Question" htmlFor={id("prompt")} required className="sm:col-span-2" hint="Write it as you'd ask Jack. It's the same question each time; Jack also sees his last answer to it.">
            <Textarea id={id("prompt")} value={form.prompt} maxLength={RECURRING_LIMITS.promptMax} rows={3} onChange={(e) => set("prompt", e.target.value)} />
          </Field>
          <Field label="How often" htmlFor={id("every")}>
            <Select id={id("every")} value={form.every} onChange={(e) => set("every", e.target.value)}>
              {(Object.keys(EVERY) as ScheduleEvery[]).map((every) => (
                <option key={every} value={every}>
                  {EVERY[every]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time (Central)" htmlFor={id("time")} hint={form.time ? clockLabel(form.time) : undefined}>
            <Input id={id("time")} type="time" step={60} value={form.time} onChange={(e) => set("time", e.target.value)} />
          </Field>
          {form.every === "week" ? (
            <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
              <legend className="mb-1.5 text-xs font-semibold text-tone-neutral-foreground">Days</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {WEEKDAYS.map((day: Weekday) => (
                  <CheckboxField
                    key={day}
                    label={WEEKDAY_LABEL[day]}
                    checked={form.days.includes(day)}
                    onChange={(e) => set("days", e.target.checked ? [...form.days, day] : form.days.filter((d) => d !== day))}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          {form.every === "month" ? (
            <Field label="Day of the month" htmlFor={id("dom")} hint="1st to 28th, so every month has it">
              <Select id={id("dom")} value={form.dayOfMonth} onChange={(e) => set("dayOfMonth", e.target.value)}>
                {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Answered by" htmlFor={id("persona")} hint={PERSONA[form.persona as RecurringPersona]?.hint}>
            <Select id={id("persona")} value={form.persona} onChange={(e) => set("persona", e.target.value)}>
              {(Object.keys(PERSONA) as RecurringPersona[]).map((persona) => (
                <option key={persona} value={persona}>
                  {PERSONA[persona].label}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGrid>
        {question ? null : (
          <SwitchField
            label="Turn it on now"
            description="Off, it's saved but never asked until someone turns it on. Automations stop for the month once they've used their cap."
            checked={form.on === true}
            onCheckedChange={(checked) => set("on", checked)}
          />
        )}
      </div>
    </Dialog>
  )
}
