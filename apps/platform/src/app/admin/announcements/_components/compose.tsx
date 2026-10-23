"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Send } from "lucide-react"
import { toast } from "sonner"
import { Button, CheckboxField, Dialog, Field, FieldGrid, Input, Select, Textarea, useConfirm } from "@/components/admin/kit"
import { unexpectedError } from "@/lib/action-result"
import { createPostAction } from "../actions"

export type ChannelOption = { id: string; name: string }
/** A role a post can ping: the server's pingable roles, plus @everyone and @here when the bot may ping them */
export type PingOption = { value: string; label: string }

export type ComposeDefaults = { channelId?: string; text?: string }

const HOURS = [
  { value: 4, label: "4 hours" },
  { value: 24, label: "1 day" },
  { value: 72, label: "3 days" },
  { value: 168, label: "1 week" },
]

/**
 * An officer's own post (Announcements → New post): a channel, the text, an optional poll and ping, now
 * or at a Central time. It goes as typed; it pings nobody unless a ping is picked
 */
export function ComposeDialog({ channels, pings, defaults, onClose }: { channels: ChannelOption[]; pings: PingOption[]; defaults?: ComposeDefaults; onClose: () => void }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [channelId, setChannelId] = useState(defaults?.channelId ?? channels[0]?.id ?? "")
  const [text, setText] = useState(defaults?.text ?? "")
  const [withPoll, setWithPoll] = useState(false)
  const [question, setQuestion] = useState("")
  const [answers, setAnswers] = useState("")
  const [hours, setHours] = useState(24)
  const [multiselect, setMultiselect] = useState(false)
  const [ping, setPing] = useState("")
  const [sendAt, setSendAt] = useState("")
  const [saving, setSaving] = useState(false)

  const channel = channels.find((c) => c.id === channelId)
  const answerList = answers.split("\n").map((a) => a.trim()).filter(Boolean)
  const ready = Boolean(channel) && (text.trim().length > 0 || (withPoll && question.trim() && answerList.length >= 2))

  async function submit() {
    if (!channel) return
    const pingLabel = pings.find((p) => p.value === ping)?.label
    const ok = await confirm({
      title: sendAt ? `Schedule this for #${channel.name}?` : `Post this in #${channel.name} now?`,
      description: `${pingLabel ? `It pings ${pingLabel}. ` : "It pings nobody. "}Once it's posted, only Discord can delete it.`,
      confirmLabel: sendAt ? "Schedule" : "Post",
    })
    if (!ok) return
    setSaving(true)
    let result
    try {
      result = await createPostAction({
        channelId,
        text: text.trim() || undefined,
        poll: withPoll ? { question: question.trim(), answers: answerList, hours, multiselect } : undefined,
        ping: ping || undefined,
        sendAt: sendAt || undefined,
      })
    } catch (error) {
      result = { ok: false as const, error: unexpectedError(error, "Couldn't post it") }
    }
    setSaving(false)
    if (!result.ok) return void toast.error(result.error)
    toast.success(result.data.summary)
    onClose()
    router.refresh()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title="New Discord post"
      description="Posted by the club's bot. Mentions in the text show as written but ping nobody; pick a ping below to notify a role."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={saving} disabled={!ready} onClick={() => void submit()}>
            <Send aria-hidden />
            {sendAt ? "Schedule" : "Post"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FieldGrid>
          <Field label="Channel" htmlFor="post-channel" required hint="Posting channels are picked by an admin on this page.">
            <Select id="post-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ping" htmlFor="post-ping" hint={pings.length ? undefined : "No role can be pinged by the bot right now."}>
            <Select id="post-ping" value={ping} onChange={(e) => setPing(e.target.value)}>
              <option value="">Nobody</option>
              {pings.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGrid>
        <Field label="Message" htmlFor="post-text" hint={`${text.length.toLocaleString("en-US")} of 2,000 characters. Discord Markdown works (**bold**, lists, links).`}>
          <Textarea id="post-text" rows={7} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
        <CheckboxField label="Add a poll" description="Polls can't be edited once posted." checked={withPoll} onChange={(e) => setWithPoll(e.target.checked)} />
        {withPoll && (
          <div className="flex flex-col gap-3 rounded-md border border-admin-row p-3">
            <Field label="Question" htmlFor="poll-question" required>
              <Input id="poll-question" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} />
            </Field>
            <Field label="Answers" htmlFor="poll-answers" required hint="One per line, 2 to 10, up to 55 characters each.">
              <Textarea id="poll-answers" rows={4} value={answers} onChange={(e) => setAnswers(e.target.value)} />
            </Field>
            <FieldGrid>
              <Field label="Open for" htmlFor="poll-hours">
                <Select id="poll-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {HOURS.map((h) => (
                    <option key={h.value} value={h.value}>
                      {h.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <CheckboxField className="sm:mt-6" label="Several answers allowed" checked={multiselect} onChange={(e) => setMultiselect(e.target.checked)} />
            </FieldGrid>
          </div>
        )}
        <Field label="Send at (Central time)" htmlFor="post-send-at" hint="Leave empty to post right away. Up to 30 days ahead.">
          <Input id="post-send-at" type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

/** The page's "New post" button */
export function NewPostButton({ channels, pings }: { channels: ChannelOption[]; pings: PingOption[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New post
      </Button>
      {open && <ComposeDialog channels={channels} pings={pings} onClose={() => setOpen(false)} />}
    </>
  )
}
