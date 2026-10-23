"use client"

import { createContext, useContext, useState } from "react"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { Button, Input } from "@/components/admin/kit"
import { FEEDBACK_NOTE_MAX, feedbackTooltip, type JackFeedbackRating, type JackFeedbackSummary } from "@/lib/jack/feedback"
import { cn } from "@/lib/utils"

/*
 * Thumbs up or down under each of Jack's replies, with an optional short note (#188, design §10). Quiet
 * on purpose: two small buttons with counts, the officer's own choice filled in, and everyone's on hover.
 * The ratings come through a context, so a change redraws only these, not every message row.
 */

export type FeedbackRoom = {
  /** Each reply's ratings, by message id, as this officer sees them */
  summaries: Record<string, JackFeedbackSummary>
  /** An archived room shows the counts but takes no ratings */
  readOnly: boolean
  /** Rates a reply (null takes the rating back); resolves with an error to show, or null */
  rate: (messageId: string, rating: JackFeedbackRating | null, note: string | null) => Promise<string | null>
}

export const FeedbackContext = createContext<FeedbackRoom | null>(null)

const NONE: JackFeedbackSummary = { up: 0, down: 0, mine: null, raters: [] }

export function ReplyFeedback({ messageId }: { messageId: string }) {
  const room = useContext(FeedbackContext)
  const [pending, setPending] = useState<"up" | "down" | "note" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The note box: open after a thumbs-down, or to edit the note
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  if (!room) return null

  const summary = room.summaries[messageId] ?? NONE
  const mine = summary.mine
  const disabled = room.readOnly || pending !== null

  async function rate(rating: JackFeedbackRating) {
    if (!room || disabled) return
    // The same thumb again takes it back; a new rating starts without a note
    const next = mine?.rating === rating ? null : rating
    setPending(rating)
    setError(null)
    const problem = await room.rate(messageId, next, null)
    setPending(null)
    if (problem) return setError(problem)
    setDraft("")
    setEditing(next === "down")
  }

  async function saveNote() {
    if (!room || pending) return
    setPending("note")
    setError(null)
    const problem = await room.rate(messageId, "down", draft)
    setPending(null)
    if (problem) return setError(problem)
    setEditing(false)
  }

  if (room.readOnly && !summary.up && !summary.down) return null

  return (
    <div className="flex max-w-3xl flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-admin-subtle" title={summary.raters.length ? feedbackTooltip(summary) : undefined}>
        <Thumb rating="up" count={summary.up} active={mine?.rating === "up"} pending={pending === "up"} disabled={disabled} onClick={() => void rate("up")} />
        <Thumb rating="down" count={summary.down} active={mine?.rating === "down"} pending={pending === "down"} disabled={disabled} onClick={() => void rate("down")} />
        {mine?.rating === "down" && !editing && !room.readOnly ? (
          <span className="flex min-w-0 items-center gap-1.5 pl-1">
            {mine.note ? <span className="max-w-[28ch] truncate sm:max-w-[48ch]">Your note: “{mine.note}”</span> : null}
            <button
              type="button"
              className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                setDraft(mine.note ?? "")
                setEditing(true)
              }}
            >
              {mine.note ? "Edit" : "Add a note"}
            </button>
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="pl-1 font-medium text-tone-danger-foreground">
            {error}
          </span>
        ) : null}
      </div>
      {editing && mine?.rating === "down" && !room.readOnly ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void saveNote()
          }}
        >
          <label htmlFor={`jack-feedback-${messageId}`} className="sr-only">
            What was wrong with this answer? (optional)
          </label>
          <Input
            id={`jack-feedback-${messageId}`}
            autoFocus
            value={draft}
            maxLength={FEEDBACK_NOTE_MAX}
            placeholder="What was wrong? (optional; it helps test Jack)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !pending) setEditing(false)
            }}
            // 16px on phones so iOS doesn't zoom in on focus
            className="h-8 min-w-0 flex-[1_1_220px] text-base md:h-7 md:text-xs"
          />
          <Button type="submit" size="sm" pending={pending === "note"}>
            Save note
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending === "note"}>
            {mine.note ? "Cancel" : "Skip"}
          </Button>
        </form>
      ) : null}
    </div>
  )
}

function Thumb({ rating, count, active, pending, disabled, onClick }: { rating: JackFeedbackRating; count: number; active: boolean; pending: boolean; disabled: boolean; onClick: () => void }) {
  const Icon = rating === "up" ? ThumbsUp : ThumbsDown
  const what = rating === "up" ? "Good answer" : "Bad answer"
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={`${what}${count ? ` (${count})` : ""}${active ? ", your rating" : ""}`}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-1.5 tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none",
        active ? "font-semibold text-foreground" : "text-admin-subtle",
        pending && "opacity-60"
      )}
    >
      <Icon aria-hidden className="size-3.5" fill={active ? "currentColor" : "none"} />
      {count ? <span>{count}</span> : null}
    </button>
  )
}
