"use client"

import { AttachButton, filesFromDrop, filesFromPaste, renderMessageFiles, UploadChips } from "@/components/jack/attachments"
import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { useJackUploads } from "@/components/jack/use-jack-uploads"
import { unexpectedError } from "@/lib/action-result"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackPresence, JackRoomPersonaKey, JackRoomSummary } from "@/lib/jack/types"
import { createJackUpload, loadJackRoomSnapshot, postJackMessage, removeJackUpload, renameJackRoom, resumeJackRoom, setJackRoomPersona } from "../actions"

type JackRoomClientProps = {
  initial: RoomSnapshotData
  rooms: JackRoomSummary[]
  me: JackPresence
  spend: JackSpend | null
}

export function JackRoomClient({ initial, rooms, me, spend }: JackRoomClientProps) {
  const room = useJackRoom({
    roomId: initial.room.id,
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

  return (
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
  )
}
