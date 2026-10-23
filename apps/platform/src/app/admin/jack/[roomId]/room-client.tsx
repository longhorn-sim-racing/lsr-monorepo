"use client"

import { useCallback, useMemo } from "react"
import { AttachButton, filesFromDrop, filesFromPaste, renderMessageFiles, UploadChips } from "@/components/jack/attachments"
import { ProposalRoomContext, type ProposalRoom } from "@/components/jack/parts/proposal-context"
import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { useJackUploads } from "@/components/jack/use-jack-uploads"
import { unexpectedError } from "@/lib/action-result"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import type { JackSpend } from "@/lib/jack/spend"
import { JACK_EVENT, type JackPresence, type JackRoomPersonaKey, type JackRoomSummary } from "@/lib/jack/types"
import { createJackUpload, loadJackRoomSnapshot, postJackMessage, removeJackUpload, renameJackRoom, resumeJackRoom, setJackRoomPersona } from "../actions"
import { applyJackProposal, discardJackProposal, type ProposalActionResult } from "../proposals/actions"

type JackRoomClientProps = {
  initial: RoomSnapshotData
  rooms: JackRoomSummary[]
  me: JackPresence
  spend: JackSpend | null
}

export function JackRoomClient({ initial, rooms, me, spend }: JackRoomClientProps) {
  const roomId = initial.room.id
  const room = useJackRoom({
    roomId,
    me,
    initial,
    loadSnapshot: loadJackRoomSnapshot,
    postMessage: postJackMessage,
    setPersona: setJackRoomPersona,
    rename: renameJackRoom,
    resume: resumeJackRoom,
  })
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

  const proposals = useMemo<ProposalRoom>(() => ({ states: room.proposals, apply, discard }), [room.proposals, apply, discard])

  return (
    <ProposalRoomContext.Provider value={proposals}>
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
        renderAttachments={renderMessageFiles}
        composer={{
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
        }}
      />
    </ProposalRoomContext.Provider>
  )
}
