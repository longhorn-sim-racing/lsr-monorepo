import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { JACK_EVENT } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import type { RoomBroadcaster } from "./broadcast"
import { savedUsage, UsageTally } from "./cost"
import { jackMessageInclude, jackRoomViewSelect, toMessageView, toRoomView } from "./messages"
import type { JackModelClient } from "./model-loop"
import { STAND_SIDE_JOB } from "./models"

/** Stand's side job: a short title for a room, from its first exchange */
const STAND_SYSTEM =
  "You name chat rooms in the officer console of a university sim racing club. Reply with only a title of 2 to 5 words, in Title Case, for the conversation you're given: no quotes, no trailing punctuation, nothing else."

const EXCERPT_CHARS = 1_500

/** Most a naming call may take by default (per attempt; the SDK may retry once) */
export const STAND_TIMEOUT_MS = 15_000

/** The JackUsage job a naming call saves (the Usage page counts it apart from automations) */
export const NAME_ROOM_JOB = "name_room"

/** How a naming call went, as its JackUsage row says */
export type StandOutcome = "named" | "declined" | "unusable" | "already_titled"

export type NameRoomInput = {
  roomId: string
  client: JackModelClient
  broadcast: RoomBroadcaster
  /** The officer messages the first reply answered, as "Name: text" lines */
  question: string
  answer: string
  /** Cancels the call (the run hit its deadline) */
  signal?: AbortSignal
  /** Longest the call may take; Stand gives up (the room stays untitled) rather than hold the function open */
  timeoutMs?: number
}

/**
 * Names an untitled room after its first reply, with Haiku (Stand). Runs in the background: any
 * failure is logged and the room just stays untitled. The title is only set if the room still has
 * none (another run's Stand may have named it meanwhile); then a note says so, "Stand named this room
 * “…”". Every call's cost is saved as a JackUsage row, whatever came of it (named, declined, an
 * unusable name, a room that already had one), and the spend meter counts those.
 */
export async function nameRoom({ roomId, client, broadcast, question, answer, signal, timeoutMs = STAND_TIMEOUT_MS }: NameRoomInput): Promise<void> {
  try {
    const config = STAND_SIDE_JOB
    const message = await client.create({
      model: config.model,
      // Room for Haiku's adaptive thinking plus a few words; low effort keeps the thinking short
      max_tokens: config.maxTokens,
      output_config: { effort: config.effort },
      system: STAND_SYSTEM,
      messages: [{ role: "user", content: `Officer messages:\n${clip(question)}\n\nReply:\n${clip(answer)}` }],
    }, { signal, timeoutMs, maxRetries: 1 })
    const usage = new UsageTally(config.model)
    usage.add(message)
    const cost = usage.costUsd
    const spent = (outcome: StandOutcome) => ({ roomId, persona: "stand" as const, job: NAME_ROOM_JOB, outcome, ...savedUsage(usage) })

    if (message.stop_reason === "refusal") {
      await prisma.jackUsage.create({ data: spent("declined") })
      console.warn(`[jack] Stand declined to name room ${roomId} ($${cost})`)
      return
    }
    const title = cleanTitle(textOf(message))
    if (!title) {
      await prisma.jackUsage.create({ data: spent("unusable") })
      console.warn(`[jack] Stand's name for room ${roomId} wasn't usable ($${cost}):`, JSON.stringify(textOf(message)))
      return
    }

    const tokens = usage.tokens
    const saved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.jackRoom.updateMany({ where: { id: roomId, title: null }, data: { title } })
      await tx.jackUsage.create({ data: spent(count ? "named" : "already_titled") })
      if (!count) return null
      const room = await tx.jackRoom.findUniqueOrThrow({ where: { id: roomId }, select: jackRoomViewSelect })
      const note = await tx.jackMessage.create({
        data: { roomId, kind: "system", content: `Stand named this room “${title}”` },
        include: jackMessageInclude,
      })
      return { room, note }
    })
    console.info(
      `[jack] Stand ${saved ? "named" : "had a name for (but it was already named)"} room ${roomId} "${title}": $${cost} (${tokens.inputTokens} in, ${tokens.outputTokens} out)`
    )
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
