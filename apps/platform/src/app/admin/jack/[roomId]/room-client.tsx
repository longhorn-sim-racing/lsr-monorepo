"use client"

import { useCallback } from "react"
import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { unexpectedError } from "@/lib/action-result"
import { outsideGap, type SnapshotGap } from "@/lib/jack/room-gap"
import type { RoomSnapshotData } from "@/lib/jack/room-state"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackPresence, JackRoomPersonaKey, JackRoomSummary } from "@/lib/jack/types"
import { loadJackRoomSnapshot, postJackMessage, renameJackRoom, resumeJackRoom, setJackRoomPersona } from "../actions"

type JackRoomClientProps = {
  initial: RoomSnapshotData
  rooms: JackRoomSummary[]
  me: JackPresence
  spend: JackSpend | null
  /** A message to open the room at (?m=), already checked to be in the snapshot */
  anchorId?: string
  /** Opened at an old message in a long room: the newer messages the snapshot left out */
  gap?: SnapshotGap
}

export function JackRoomClient({ initial, rooms, me, spend, anchorId, gap }: JackRoomClientProps) {
  // Opened at an old message: the room's fresh snapshots (its latest messages) mustn't fill in the gap
  // after the window, or the page would hold twice as many messages with a hole in the middle
  // (kept by value, so the callback, and the live channel that depends on it, stay put across renders)
  const [afterId, afterAt, throughId, throughAt] = gap ? [gap.after.id, gap.after.createdAt, gap.through.id, gap.through.createdAt] : []
  const loadSnapshot = useCallback(
    async (roomId: string) => {
      const result = await loadJackRoomSnapshot(roomId)
      if (!result.ok || !afterId || !afterAt || !throughId || !throughAt) return result
      const messages = outsideGap(result.data.messages, { after: { id: afterId, createdAt: afterAt }, through: { id: throughId, createdAt: throughAt } })
      return { ...result, data: { ...result.data, messages } }
    },
    [afterId, afterAt, throughId, throughAt]
  )
  const room = useJackRoom({
    roomId: initial.room.id,
    me,
    initial,
    loadSnapshot,
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
      anchorId={anchorId}
      gap={gap ? { afterId: gap.after.id, count: gap.count } : undefined}
    />
  )
}
