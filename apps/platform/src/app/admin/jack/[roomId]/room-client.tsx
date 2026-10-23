"use client"

import { useCallback, useMemo, useState } from "react"
import { AttachButton, filesFromDrop, filesFromPaste, renderMessageFiles, UploadChips } from "@/components/jack/attachments"
import { ProposalRoomContext, type ProposalRoom } from "@/components/jack/parts/proposal-context"
import { FeedbackContext, ReplyFeedback, type FeedbackRoom } from "@/components/jack/reply-feedback"
import { ArchivedBar, RoomSettingsMenu } from "@/components/jack/room-settings"
import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { useJackUploads } from "@/components/jack/use-jack-uploads"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import type { JackFeedbackRating, JackFeedbackSummary } from "@/lib/jack/feedback"
import { mentionPlaceholder, type JackAnswerMode } from "@/lib/jack/mentions"
import { PROPOSAL_ROOM_ARCHIVED } from "@/lib/jack/proposals"
import { outsideGap, type SnapshotGap } from "@/lib/jack/room-gap"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import type { JackSpend } from "@/lib/jack/spend"
import { JACK_EVENT, type JackMessageView, type JackPresence, type JackRoomPersonaKey, type JackRoomSummary, type JackRoomView as JackRoomSettings } from "@/lib/jack/types"
import { createJackUpload, loadJackRoomSnapshot, postJackMessage, removeJackUpload, renameJackRoom, resumeJackRoom, setJackRoomPersona } from "../actions"
import { applyJackProposal, discardJackProposal, type ProposalActionResult } from "../proposals/actions"
import { archiveJackRoom, pinJackRoom, rateJackReply, setJackRoomAnswerMode } from "../room-actions"

type JackRoomClientProps = {
  initial: RoomSnapshotData
  rooms: JackRoomSummary[]
  me: JackPresence
  spend: JackSpend | null
  /** A message to open the room at (?m=), already checked to be in the snapshot */
  anchorId?: string
  /** Opened at an old message in a long room: the newer messages the snapshot left out */
  gap?: SnapshotGap
  /** The replies' ratings as this officer sees them, by message id */
  feedback?: Record<string, JackFeedbackSummary>
}

/** An archived room starts no runs; its page doesn't ask (the room offers no "continue" there either) */
const archivedResume = async (): Promise<ActionResult> => ({ ok: false, error: "This room is archived." })

/** An archived room is read-only, so its proposal cards say so instead of applying or discarding (the server refuses too) */
const archivedProposalAction = async (): Promise<string | null> => PROPOSAL_ROOM_ARCHIVED

/** Two sets of ratings say the same thing, so a snapshot doesn't redraw every rating for nothing */
const sameFeedback = (a: Record<string, JackFeedbackSummary>, b: Record<string, JackFeedbackSummary>) => JSON.stringify(a) === JSON.stringify(b)

export function JackRoomClient({ initial, rooms, me, spend, anchorId, gap, feedback: initialFeedback = {} }: JackRoomClientProps) {
  const roomId = initial.room.id
  const [feedback, setFeedback] = useState(initialFeedback)
  // Opened at an old message: the room's fresh snapshots (its latest messages) mustn't fill in the gap
  // after the window, or the page would hold twice as many messages with a hole in the middle
  // (kept by value, so the callback, and the live channel that depends on it, stay put across renders)
  const [afterId, afterAt, throughId, throughAt] = gap ? [gap.after.id, gap.after.createdAt, gap.through.id, gap.through.createdAt] : []
  const loadSnapshot = useCallback(
    async (roomId: string) => {
      const result = await loadJackRoomSnapshot(roomId)
      // Ratings come with every snapshot, so other officers' show up as the room catches up
      const fresh = result.ok ? result.data.feedback : undefined
      if (fresh) setFeedback((known) => (sameFeedback(known, fresh) ? known : fresh))
      if (!result.ok || !afterId || !afterAt || !throughId || !throughAt) return result
      const messages = outsideGap(result.data.messages, { after: { id: afterId, createdAt: afterAt }, through: { id: throughId, createdAt: throughAt } })
      return { ...result, data: { ...result.data, messages } }
    },
    [afterId, afterAt, throughId, throughAt]
  )
  const [archived, setArchived] = useState(Boolean(initial.room.archivedAt))
  const room = useJackRoom({
    roomId,
    me,
    initial,
    loadSnapshot,
    postMessage: postJackMessage,
    setPersona: setJackRoomPersona,
    rename: renameJackRoom,
    resume: archived ? archivedResume : resumeJackRoom,
  })
  // The live copy says whether it's archived (another officer may archive it while this page is open)
  const isArchived = Boolean(room.room.archivedAt)
  if (isArchived !== archived) setArchived(isArchived)
  const uploads = useJackUploads({ roomId: initial.room.id, createUpload: createJackUpload, removeUpload: removeJackUpload })

  async function send(content: string) {
    try {
      // Files still uploading go with this message once they're done (Send shows it's working meanwhile);
      // files added during the wait stay in the composer for the next message
      const files = await uploads.settle()
      if (!files.ok) return files.error
      if (!content.trim() && !files.fileIds.length) return "Type a message first"
      const result = await room.send(content, files.fileIds)
      if (result.ok) uploads.clear(files.keys)
      return result.ok ? null : result.error
    } catch (error) {
      return unexpectedError(error, "Couldn't send that")
    }
  }

  async function switchPersona(persona: JackRoomPersonaKey) {
    try {
      const result = await room.switchPersona(persona)
      return result.ok ? null : result.error
    } catch (error) {
      return unexpectedError(error, "Couldn't switch")
    }
  }

  async function rename(title: string) {
    try {
      const result = await room.renameRoom(title)
      return result.ok ? null : result.error
    } catch (error) {
      return unexpectedError(error, "Couldn't rename the room")
    }
  }

  async function continueRoom() {
    try {
      const result = await room.continueRoom()
      return result.ok ? null : result.error
    } catch (error) {
      return unexpectedError(error, "Couldn't ask Jack to continue")
    }
  }

  // A proposal's new status and its room note show at once; the broadcast copies then change nothing
  const { receive } = room
  const settle = useCallback(
    (result: ProposalActionResult) => {
      const proposal = result.ok ? result.data.proposal : result.proposal
      const note = result.ok ? result.data.note : result.note
      if (proposal) receive({ type: JACK_EVENT.proposal, roomId, proposal })
      if (note) receive({ type: JACK_EVENT.created, message: note })
      return result.ok ? null : result.error
    },
    [receive, roomId]
  )

  const apply = useCallback(
    async (id: string, selectedRows?: string[]) => {
      try {
        return settle(await applyJackProposal(id, selectedRows))
      } catch (error) {
        return unexpectedError(error, "Couldn't apply it")
      }
    },
    [settle]
  )

  const discard = useCallback(
    async (id: string) => {
      try {
        return settle(await discardJackProposal(id))
      } catch (error) {
        return unexpectedError(error, "Couldn't discard it")
      }
    },
    [settle]
  )

  const proposals = useMemo<ProposalRoom>(
    () => (archived ? { states: room.proposals, apply: archivedProposalAction, discard: archivedProposalAction } : { states: room.proposals, apply, discard }),
    [room.proposals, archived, apply, discard]
  )

  /** A setting changed here shows at once (the new settings, then its note); the broadcast copies then change nothing */
  async function changeSetting(work: () => Promise<ActionResult<{ room: JackRoomSettings; message?: JackMessageView | null }>>, what: string) {
    try {
      const result = await work()
      if (!result.ok) return result.error
      receive({ type: JACK_EVENT.room, room: result.data.room })
      if (result.data.message) receive({ type: JACK_EVENT.created, message: result.data.message })
      return null
    } catch (error) {
      return unexpectedError(error, what)
    }
  }

  const pin = (pinned: boolean) => changeSetting(() => pinJackRoom(roomId, pinned), pinned ? "Couldn't pin the room" : "Couldn't unpin the room")
  const setAnswerMode = (mode: JackAnswerMode) => changeSetting(() => setJackRoomAnswerMode(roomId, mode), "Couldn't change how Jack answers here")
  const archive = (next: boolean) => changeSetting(() => archiveJackRoom(roomId, next), next ? "Couldn't archive the room" : "Couldn't unarchive the room")

  const rate = useCallback(async (messageId: string, rating: JackFeedbackRating | null, note: string | null) => {
    try {
      const result = await rateJackReply(messageId, rating, note)
      if (!result.ok) return result.error
      setFeedback((known) => ({ ...known, [messageId]: result.data.summary }))
      return null
    } catch (error) {
      return unexpectedError(error, "Couldn't save your rating")
    }
  }, [])
  const feedbackRoom = useMemo<FeedbackRoom>(() => ({ summaries: feedback, readOnly: archived, rate }), [feedback, archived, rate])

  // Ratings go under Jack's finished replies. Stable, so a rating redraws only its own buttons (through the context)
  const messageActions = useCallback((message: JackMessageView) => (message.author.kind === "assistant" && message.status !== "streaming" ? <ReplyFeedback messageId={message.id} /> : null), [])

  return (
    <ProposalRoomContext.Provider value={proposals}>
      <FeedbackContext.Provider value={feedbackRoom}>
        <JackRoomView
          room={room.room}
          rooms={rooms}
          spend={spend}
          messages={room.messages}
          present={room.present}
          connection={room.connection}
          stall={room.stall}
          onSend={send}
          onSwitchPersona={switchPersona}
          onRename={rename}
          onContinue={continueRoom}
          anchorId={anchorId}
          gap={gap ? { afterId: gap.after.id, count: gap.count } : undefined}
          renderAttachments={renderMessageFiles}
          messageActions={messageActions}
          headerActions={archived ? null : <RoomSettingsMenu room={room.room} onPin={pin} onAnswerMode={setAnswerMode} onArchive={() => archive(true)} />}
          composer={
            archived
              ? { readOnly: <ArchivedBar archivedAt={room.room.archivedAt} onUnarchive={() => archive(false)} /> }
              : {
                  addons: <AttachButton onFiles={uploads.add} />,
                  attachments: <UploadChips items={uploads.items} notice={uploads.notice} onRemove={uploads.remove} />,
                  onPaste: (event) => {
                    const files = filesFromPaste(event)
                    if (!files.length) return
                    event.preventDefault()
                    uploads.add(files)
                  },
                  onDrop: (event) => {
                    // Dropped text goes into the message box as usual; dropped files would otherwise open in the tab
                    const files = filesFromDrop(event)
                    if (!files.length) return
                    event.preventDefault()
                    uploads.add(files)
                  },
                  canSendEmpty: uploads.items.length > 0,
                  // Mention mode: only messages that mention Jack get an answer
                  placeholder: room.room.answerMode === "mention" ? mentionPlaceholder(room.room.persona) : undefined,
                }
          }
        />
      </FeedbackContext.Provider>
    </ProposalRoomContext.Provider>
  )
}
