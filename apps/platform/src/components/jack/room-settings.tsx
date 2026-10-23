"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Badge, Button, RowMenu } from "@/components/admin/kit"
import { mentionNames, type JackAnswerMode } from "@/lib/jack/mentions"
import { JACK_PERSONA_NAME, type JackRoomView } from "@/lib/jack/types"

/*
 * A room's own settings in its header (#188, design §10): pin, mention mode and archive, and the bar an
 * archived room shows in place of the composer. They report what the officer picks; the room page runs
 * the actions.
 */

type Settings = {
  room: JackRoomView
  /** Each resolves with an error to show, or null once done */
  onPin: (pinned: boolean) => Promise<string | null>
  onAnswerMode: (mode: JackAnswerMode) => Promise<string | null>
  onArchive: () => Promise<string | null>
}

/** The room's menu, with a badge while it answers only mentions */
export function RoomSettingsMenu({ room, onPin, onAnswerMode, onArchive }: Settings) {
  const mention = room.answerMode === "mention"
  const names = mentionNames(room.persona)
    .map((name) => `@${name}`)
    .join(" or ")

  async function run(work: Promise<string | null>, done?: string) {
    const problem = await work
    if (problem) toast.error(problem)
    else if (done) toast.success(done)
  }

  return (
    <div className="flex items-center gap-2">
      {mention ? (
        <Badge tone="info" className="cursor-default">
          <span title={`${JACK_PERSONA_NAME[room.persona]} answers only messages that mention ${names}`}>Mentions only</span>
        </Badge>
      ) : null}
      <RowMenu
        label="Room options"
        items={[
          room.pinnedAt
            ? { label: "Unpin room", onSelect: () => run(onPin(false), "Unpinned. It sorts by activity again.") }
            : { label: "Pin room to the top", onSelect: () => run(onPin(true), "Pinned to the top of the rooms list.") },
          mention
            ? { label: "Answer every message", onSelect: () => run(onAnswerMode("always")) }
            : { label: `Answer only when mentioned (${names})`, onSelect: () => run(onAnswerMode("mention")) },
          "separator",
          { label: "Archive room", onSelect: () => run(onArchive()) },
        ]}
      />
    </div>
  )
}

/** In place of an archived room's composer: it's read-only until someone unarchives it */
export function ArchivedBar({ archivedAt, onUnarchive }: { archivedAt: string | null | undefined; onUnarchive: () => Promise<string | null> }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unarchive() {
    setPending(true)
    setError(null)
    const problem = await onUnarchive()
    setPending(false)
    if (problem) setError(problem)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>
        <strong className="font-semibold text-foreground">Archived</strong> — unarchive to continue
        {archivedAt ? <span className="text-admin-subtle"> · {archivedOn.format(new Date(archivedAt))}</span> : null}
        {error ? (
          <span role="alert" className="mt-0.5 block text-xs font-medium text-tone-danger-foreground">
            {error}
          </span>
        ) : null}
      </span>
      <Button size="sm" pending={pending} onClick={() => void unarchive()}>
        Unarchive
      </Button>
    </div>
  )
}

const archivedOn = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" })
