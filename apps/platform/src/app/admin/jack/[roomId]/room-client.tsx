"use client"

import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { unexpectedError } from "@/lib/action-result"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackPresence, JackRoomPersonaKey, JackRoomSummary } from "@/lib/jack/types"
import { loadJackRoomSnapshot, postJackMessage, renameJackRoom, resumeJackRoom, setJackRoomPersona } from "../actions"

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

  async function send(content: string) {
    try {
      const result = await room.send(content)
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
    />
  )
}
