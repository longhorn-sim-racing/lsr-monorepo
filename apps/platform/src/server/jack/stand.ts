import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { JACK_EVENT } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import type { RoomBroadcaster } from "./broadcast"
import { UsageTally } from "./cost"
import { jackMessageInclude, jackRoomViewSelect, toMessageView, toRoomView } from "./messages"
import type { JackModelClient } from "./model-loop"
import { JACK_MODELS } from "./models"

/** Stand's side job: a short title for a room, from its first exchange */
const STAND_SYSTEM =
  "You name chat rooms in the officer console of a university sim racing club. Reply with only a title of 2 to 5 words, in Title Case, for the conversation you're given: no quotes, no trailing punctuation, nothing else."

const EXCERPT_CHARS = 1_500

export type NameRoomInput = {
  roomId: string
  client: JackModelClient
  broadcast: RoomBroadcaster
  /** The officer messages the first reply answered, as "Name: text" lines */
  question: string
  answer: string
}

/**
 * Names an untitled room after its first reply, with Haiku (Stand). Runs in the background: any
 * failure is logged and the room just stays untitled. The title is only set if the room still has
 * none (an officer may have named it meanwhile). Stand's cost is saved on a system note in the room,
 * "Stand named this room “…”", which is what the spend meter counts.
 */
export async function nameRoom({ roomId, client, broadcast, question, answer }: NameRoomInput): Promise<void> {
  try {
    const config = JACK_MODELS.stand
    const message = await client.create({
      model: config.model,
      // Room for Haiku's adaptive thinking plus a few words; low effort keeps the thinking short
      max_tokens: config.maxTokens,
      output_config: { effort: config.effort },
      system: STAND_SYSTEM,
      messages: [{ role: "user", content: `Officer messages:\n${clip(question)}\n\nReply:\n${clip(answer)}` }],
    })
    const usage = new UsageTally(config.model)
    usage.add(message)
    const cost = usage.costUsd

    if (message.stop_reason === "refusal") {
      console.warn(`[jack] Stand declined to name room ${roomId} ($${cost})`)
      return
    }
    const title = cleanTitle(textOf(message))
    if (!title) {
      console.warn(`[jack] Stand's name for room ${roomId} wasn't usable ($${cost}):`, JSON.stringify(textOf(message)))
      return
    }

    const tokens = usage.tokens
    const saved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.jackRoom.updateMany({ where: { id: roomId, title: null }, data: { title } })
      if (!count) return null
      const room = await tx.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
      const note = await tx.jackMessage.create({
        data: {
          roomId,
          kind: "system",
          content: `Stand named this room “${title}”`,
          model: usage.models.join(","),
          inputTokens: tokens.inputTokens + tokens.cacheWriteTokens,
          outputTokens: tokens.outputTokens,
          cacheReadTokens: tokens.cacheReadTokens,
          costUsd: cost,
        },
        include: jackMessageInclude,
      })
      return { room, note }
    })
    console.info(`[jack] Stand named room ${roomId} "${title}": $${cost} (${tokens.inputTokens} in, ${tokens.outputTokens} out)`)
    if (!saved) return

    await broadcast(roomId, { type: JACK_EVENT.room, room: toRoomView(saved.room) })
    await broadcast(roomId, { type: JACK_EVENT.created, message: toMessageView(saved.note) })
  } catch (error) {
    console.error(`[jack] Stand couldn't name room ${roomId}:`, error)
  }
}

function clip(text: string) {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text
}

function textOf(message: BetaMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

/** The title from Stand's reply: its first line without quotes, labels or end punctuation. Null when it isn't a short name */
export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
  const title = line
    .replace(/^(room name|room title|title|name)\s*:\s*/i, "")
    .replace(/^["'“”‘’*_#`\s]+/, "")
    .replace(/["'“”‘’*_`.!?\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
  const words = title ? title.split(" ").length : 0
  if (words < 1 || words > 8 || title.length > 80) return null
  return title
}
