import { randomUUID } from "node:crypto"
import type { Prisma } from "@prisma/client"
import type { JackToolPart } from "@/lib/jack/parts"
import { formatUsd } from "@/lib/jack/spend"
import { JACK_EVENT, JACK_PERSONA_NAME, type JackRoomPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "./broadcast"
import { UsageTally } from "./cost"
import { DeltaStream } from "./delta-stream"
import { buildHistory } from "./history"
import { FORMER_OFFICER, jackMessageInclude, toMessageView, type JackMessageRow } from "./messages"
import { anthropicJackClient, runModelReply, type JackModelClient, type ReplyLimits, type ReplyOutcome } from "./model-loop"
import { JACK_MODELS } from "./models"
import { buildSystemPrompt } from "./prompt"
import { releaseRoomLock, renewRoomLock, tryAcquireRoomLock } from "./room-lock"
import { getMonthSpend } from "./spend"
import { nameRoom } from "./stand"
import { JACK_TOOLS } from "./tools"
import type { AnyJackTool } from "./tools/types"

export type ReplyLoopDeps = {
  broadcast: RoomBroadcaster
  /** Claude, or null when ANTHROPIC_API_KEY isn't set (Jack then says so in the room) */
  getClient: () => JackModelClient | null
  tools: AnyJackTool[]
  /** This month's spend against JACK_MONTHLY_BUDGET_USD, checked before every reply */
  budget: () => Promise<{ month: string; spentUsd: number; budgetUsd: number }>
  limits?: Partial<ReplyLimits>
}

let cachedClient: { key: string; client: JackModelClient } | null = null

function claudeFromEnv(): JackModelClient | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key) return null
  if (cachedClient?.key !== key) cachedClient = { key, client: anthropicJackClient(key) }
  return cachedClient.client
}

export const defaultReplyDeps: ReplyLoopDeps = {
  broadcast: broadcastRoomEvent,
  getClient: claudeFromEnv,
  tools: JACK_TOOLS,
  budget: async () => {
    const spend = await getMonthSpend()
    return { month: spend.month, spentUsd: spend.totalUsd, budgetUsd: spend.budgetUsd }
  },
}

/** How much of a room the history is built from (it keeps the last 40 exchanges of that) */
const HISTORY_ROWS = 2_000

/**
 * A reply that's still going after this is cancelled (its Claude call and any running tool are
 * aborted), so it ends with a message inside the function's 300 s maxDuration. Replies are told to
 * wrap up well before (REPLY_LIMITS.maxElapsedMs).
 */
const REPLY_DEADLINE_MS = 240_000

/** Officer messages nobody has answered yet, oldest first (system notes don't get answers) */
function findUnanswered(roomId: string) {
  return prisma.jackMessage.findMany({
    where: { roomId, kind: "user", answeredById: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: jackMessageInclude,
  })
}

async function hasUnanswered(roomId: string) {
  const first = await prisma.jackMessage.findFirst({
    where: { roomId, kind: "user", answeredById: null },
    select: { id: true },
  })
  return first !== null
}

/**
 * Answers a room until nothing in it is left unanswered, unless another run already is. Runs on the
 * server, independent of any browser tab (posting starts it after the response).
 *
 * Each pass answers every officer message that's waiting, together in one reply, so messages posted
 * mid-answer are picked up by the next pass. When nothing is waiting the run lets go of the lock,
 * then looks once more: a message posted just before that found the lock taken and left it to this
 * run, so if one is there the run takes the lock back (or sees that a newer run has it). That way
 * nothing is ever left unanswered.
 *
 * Side jobs a reply starts (Stand naming the room) run alongside and are awaited before it returns,
 * so the function stays alive for them.
 */
export async function runRoom(roomId: string, deps: ReplyLoopDeps = defaultReplyDeps): Promise<void> {
  const runId = randomUUID()
  if (!(await tryAcquireRoomLock(roomId, runId))) return
  const sideJobs: Promise<void>[] = []
  let holding = true
  try {
    await closeInterruptedReplies(roomId, deps)
    for (;;) {
      const waiting = await findUnanswered(roomId)
      if (waiting.length) {
        if (!(await renewRoomLock(roomId, runId))) {
          holding = false // a newer run took over a lock it thought was stale; it answers from here
          return
        }
        await answer(roomId, waiting, deps, sideJobs)
        continue
      }

      await releaseRoomLock(roomId, runId)
      holding = false
      if (!(await hasUnanswered(roomId))) return
      if (!(await tryAcquireRoomLock(roomId, runId))) return // another run has it and will answer
      holding = true
    }
  } finally {
    if (holding) await releaseRoomLock(roomId, runId).catch((error) => console.error("[jack] Couldn't release the room lock:", error))
    await Promise.allSettled(sideJobs)
  }
}

/**
 * Replies still marked streaming when a run takes the lock belong to a run that died (one run per
 * room), so close them as errors and tell the room.
 */
async function closeInterruptedReplies(roomId: string, deps: ReplyLoopDeps) {
  const stuck = await prisma.jackMessage.findMany({ where: { roomId, status: "streaming" }, select: { id: true } })
  for (const { id } of stuck) {
    const closed = await prisma.jackMessage.update({ where: { id }, data: { status: "error" }, include: jackMessageInclude })
    await deps.broadcast(roomId, { type: JACK_EVENT.done, message: toMessageView(closed) })
  }
}

/** What a reply came to: Claude's answer, or a notice that Claude wasn't asked (no key, budget used up) */
type Produced = {
  text: string
  status: "done" | "error"
  outcome: ReplyOutcome | "no_api_key" | "over_budget"
  parts: JackToolPart[]
  toolCalls: number
}

/** One reply to every message in `waiting`, from the room's persona as it is now */
async function answer(roomId: string, waiting: JackMessageRow[], deps: ReplyLoopDeps, sideJobs: Promise<void>[]) {
  const reply = await prisma.$transaction(async (tx) => {
    const room = await tx.jackRoom.findUnique({ where: { id: roomId }, select: { persona: true } })
    const created = await tx.jackMessage.create({
      data: { roomId, kind: "assistant", persona: room?.persona ?? "jack", status: "streaming" },
      include: jackMessageInclude,
    })
    await tx.jackMessage.updateMany({
      where: { id: { in: waiting.map((m) => m.id) }, answeredById: null },
      data: { answeredById: created.id },
    })
    return created
  })
  await deps.broadcast(roomId, { type: JACK_EVENT.created, message: toMessageView(reply) })

  const persona: JackRoomPersonaKey = reply.persona === "lift" ? "lift" : "jack"
  const usage = new UsageTally(JACK_MODELS[persona].model)
  const startedAt = Date.now()
  let parts: JackToolPart[] = []

  const stream = new DeltaStream({
    roomId,
    messageId: reply.id,
    broadcast: deps.broadcast,
    persist: async (content, streamSeq) => {
      await prisma.jackMessage.update({ where: { id: reply.id }, data: { content, streamSeq } })
    },
  })

  let produced: Produced | null = null
  let status: "done" | "error"
  let result: { content: string; streamSeq: number }
  try {
    produced = await produce(roomId, reply, persona, waiting, deps, stream, usage, (latest) => {
      parts = latest
    })
    status = produced.status
    parts = produced.parts
    const ended = await stream.end()
    // The reply's own text, not what streamed: a declined partial is dropped from it
    result = { content: produced.text, streamSeq: ended.streamSeq }
  } catch (error) {
    console.error(`[jack] Reply ${reply.id} in room ${roomId} failed:`, error)
    status = "error"
    const sent = stream.abort()
    result = { content: produced?.text ?? sent.content, streamSeq: sent.streamSeq }
  }

  const tokens = usage.tokens
  if (usage.calls) {
    console.info(
      `[jack] Reply ${reply.id} in room ${roomId}: ${JACK_PERSONA_NAME[persona]} (${usage.models.join(", ")}) $${usage.costUsd}, ` +
        `${tokens.inputTokens} in + ${tokens.cacheWriteTokens} cache write + ${tokens.cacheReadTokens} cache read, ${tokens.outputTokens} out, ` +
        `${usage.calls} calls, ${produced?.toolCalls ?? 0} tool calls, ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ${produced?.outcome ?? "failed"}`
    )
  }

  let final: JackMessageRow
  try {
    final = await prisma.jackMessage.update({
      where: { id: reply.id },
      data: {
        content: result.content,
        streamSeq: result.streamSeq,
        status,
        ...(parts.length ? { toolCalls: parts as unknown as Prisma.InputJsonValue } : {}),
        ...(usage.calls
          ? {
              model: usage.models.join(","),
              // Everything not read from the cache; the whole prompt is this plus cacheReadTokens
              inputTokens: tokens.inputTokens + tokens.cacheWriteTokens,
              outputTokens: tokens.outputTokens,
              cacheReadTokens: tokens.cacheReadTokens,
              costUsd: usage.costUsd,
            }
          : {}),
      },
      include: jackMessageInclude,
    })
  } catch (error) {
    // Viewers still get the ending; the next run closes the row as interrupted
    console.error(`[jack] Couldn't save reply ${reply.id}:`, error)
    final = { ...reply, ...result, status: "error", toolCalls: parts as unknown as Prisma.JsonValue }
  }
  await deps.broadcast(roomId, { type: JACK_EVENT.done, message: toMessageView(final) })

  // Stand names an untitled room after its first real answer (one Claude wrote, not a notice or a refusal), in the background
  if (status === "done" && usage.calls > 0 && produced?.outcome !== "refusal" && !sideJobs.length) {
    const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { title: true } })
    const claude = deps.getClient()
    if (room?.title === null && claude) {
      const budget = await deps.budget()
      if (budget.spentUsd < budget.budgetUsd) {
        sideJobs.push(nameRoom({ roomId, client: claude, broadcast: deps.broadcast, question: officerLines(waiting), answer: result.content }))
      }
    }
  }
}

async function produce(
  roomId: string,
  reply: JackMessageRow,
  persona: JackRoomPersonaKey,
  waiting: JackMessageRow[],
  deps: ReplyLoopDeps,
  stream: DeltaStream,
  usage: UsageTally,
  onParts: (parts: JackToolPart[]) => void
): Promise<Produced> {
  const name = JACK_PERSONA_NAME[persona]
  const notice = (text: string, outcome: Produced["outcome"]): Produced => {
    stream.write(text)
    return { text, status: "done", outcome, parts: [], toolCalls: 0 }
  }

  const claude = deps.getClient()
  if (!claude) return notice(`${name} isn't connected yet: an admin needs to add the Anthropic API key.`, "no_api_key")

  const budget = await deps.budget()
  if (budget.spentUsd >= budget.budgetUsd) {
    return notice(
      `${name}'s monthly budget is used up: ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.budgetUsd, { wholeIfRound: true })} spent in ${budget.month}. ` +
        `${name} answers again next month, or an admin can raise JACK_MONTHLY_BUDGET_USD.`,
      "over_budget"
    )
  }

  const rows = await prisma.jackMessage.findMany({
    where: { roomId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_ROWS,
    include: jackMessageInclude,
  })
  const history = buildHistory(rows.reverse(), reply.id)
  const latest = waiting[waiting.length - 1]

  const out = await runModelReply({
    client: claude,
    config: JACK_MODELS[persona],
    system: buildSystemPrompt(persona),
    tools: deps.tools,
    history,
    // Tools run as the officer whose message is newest
    ctx: { roomId, actor: { userId: latest.authorUserId, displayName: latest.author?.displayName ?? FORMER_OFFICER } },
    onText: (text) => stream.write(text),
    onPart: (part, all) => {
      onParts(all)
      return stream.sendInOrder(async () => {
        try {
          await prisma.jackMessage.update({ where: { id: reply.id }, data: { toolCalls: all as unknown as Prisma.InputJsonValue } })
        } catch (error) {
          console.error(`[jack] Couldn't save tool calls on reply ${reply.id}:`, error)
        }
        await deps.broadcast(roomId, { type: JACK_EVENT.tool, messageId: reply.id, part })
      })
    },
    usage,
    limits: deps.limits,
    signal: AbortSignal.timeout(REPLY_DEADLINE_MS),
  })
  return { text: out.text, status: out.status, outcome: out.outcome, parts: out.parts, toolCalls: out.toolCalls }
}

/** The messages a reply answered, as Stand reads them */
function officerLines(waiting: JackMessageRow[]): string {
  return waiting.map((m) => `${m.author?.displayName ?? FORMER_OFFICER}: ${m.content}`).join("\n")
}
