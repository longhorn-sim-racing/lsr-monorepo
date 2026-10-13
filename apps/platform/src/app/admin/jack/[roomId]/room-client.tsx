"use client"

import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { unexpectedError } from "@/lib/action-result"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import { jackRoomTitle, type JackPresence, type JackRoomPersonaKey, type JackRoomSummary } from "@/lib/jack/types"
import { loadJackRoomSnapshot, postJackMessage, setJackRoomPersona } from "../actions"

type JackRoomClientProps = {
  initial: RoomSnapshotData
  rooms: JackRoomSummary[]
  me: JackPresence
}

export function JackRoomClient({ initial, rooms, me }: JackRoomClientProps) {
  const room = useJackRoom({
    roomId: initial.room.id,
    me,
    initial,
    loadSnapshot: loadJackRoomSnapshot,
    postMessage: postJackMessage,
    setPersona: setJackRoomPersona,
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

  return (
    <JackRoomView
      roomId={room.room.id}
      rooms={rooms}
      title={jackRoomTitle(room.room)}
      persona={room.room.persona}
      messages={room.messages}
      present={room.present}
      connection={room.connection}
      onSend={send}
      onSwitchPersona={switchPersona}
    />
  )
}
