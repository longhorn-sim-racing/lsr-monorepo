"use client"

import { JackRoomView } from "@/components/jack/room-view"
import { useJackRoom } from "@/components/jack/use-jack-room"
import { unexpectedError } from "@/lib/action-result"
import type { JackMessageView, JackPresence } from "@/lib/jack/types"
import { loadJackRoomSnapshot, postJackMessage } from "../actions"

type JackRoomClientProps = {
  roomId: string
  title: string
  initialMessages: JackMessageView[]
  me: JackPresence
}

export function JackRoomClient({ roomId, title, initialMessages, me }: JackRoomClientProps) {
  const room = useJackRoom({ roomId, me, initialMessages, loadSnapshot: loadJackRoomSnapshot, postMessage: postJackMessage })

  async function send(content: string) {
    try {
      const result = await room.send(content)
      return result.ok ? null : result.error
    } catch (error) {
      return unexpectedError(error, "Couldn't send that")
    }
  }

  return (
    <JackRoomView title={title} messages={room.messages} present={room.present} connection={room.connection} onSend={send} />
  )
}
