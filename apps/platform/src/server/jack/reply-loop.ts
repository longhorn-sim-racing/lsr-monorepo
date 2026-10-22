import { randomUUID } from "node:crypto"
import type { Prisma } from "@prisma/client"
import type { JackToolPart } from "@/lib/jack/parts"
import { formatUsd } from "@/lib/jack/spend"
import { isJackRoomPersona, JACK_EVENT, JACK_PERSONA_NAME, type JackRoomPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "./broadcast"
import { savedUsage, UsageTally } from "./cost"
import { DeltaStream } from "./delta-stream"
import { buildHistory } from "./history"
import { FORMER_OFFICER, jackMessageInclude, toMessageView, type JackMessageRow } from "./messages"
import { anthropicJackClient, REPLY_LIMITS, runModelReply, type JackModelClient, type ReplyLimits, type ReplyOutcome } from "./model-loop"
import { JACK_MODELS } from "./models"
import { buildSystemPrompt } from "./prompt"
import { releaseRoomLock, renewRoomLock, tryAcquireRoomLock } from "./room-lock"
import { getMonthSpend } from "./spend"
import { nameRoom, STAND_TIMEOUT_MS } from "./stand"
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
  /** Overrides RUN_TIMING (tests) */
  timing?: Partial<RunTiming>
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
 * How long a run and its answers may take. A run lives inside the function that started it (the
 * room page's, maxDuration 300 s), which can be cut off with no warning, so it keeps well inside that:
 */
export type RunTiming = {
  /**
   * From the start of the request that started the run (runRoom's `startedAt`): an answer still going
   * then is cancelled, and no new one starts. What's left after it (the last save, the done event,
   * letting go of the lock) has to fit in the rest of the function's 300 s
   */
  runDeadlineMs: number
  /** A new answer starts only with at least this long left before the run deadline; otherwise the run lets go */
  minAnswerMs: number
  /** One answer is cancelled after this long, whatever's left of the run (its Claude call and any running tool are aborted) */
  replyDeadlineMs: number
}

export const RUN_TIMING: RunTiming = { runDeadlineMs: 280_000, minAnswerMs: 150_000, replyDeadlineMs: 240_000 }

/** An answer is told to wrap up (REPLY_LIMITS.maxElapsedMs) at least this long before it would be cancelled */
const WRAP_UP_MARGIN_MS = 60_000
/** Stand names a room only with at least this long left before the run's deadline (otherwise a later answer does) */
const STAND_MIN_LEFT_MS = 20_000
/** Stand's call ends at least this long before the run's deadline */
const STAND_MARGIN_MS = 5_000

/** A signal that fires after `ms`, on a timer that can be cleared (and that fake timers control in tests) */
function deadline(ms: number, reason: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(reason)), Math.max(0, ms))
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

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
 * server, independent of any browser tab (posting starts it after the response, and so does an
 * officer asking Jack to continue).
 *
 * Each pass answers every officer message that's waiting, together in one reply, so messages posted
 * mid-answer are picked up by the next pass. When nothing is waiting the run lets go of the lock,
 * then looks once more: a message posted just before that found the lock taken and left it to this
 * run, so if one is there the run takes the lock back (or sees that a newer run has it). That way
 * nothing is left unanswered while the run has time.
 *
 * A run has RUN_TIMING.runDeadlineMs in all. It doesn't start an answer with less than minAnswerMs
 * left: it lets go of the lock instead and leaves the messages waiting, for the next post or for an
 * officer to ask Jack to continue (the room shows that button when messages sit unanswered).
 *
 * Side jobs a reply starts (Stand naming the room) run alongside and are awaited before it returns,
 * so the function stays alive for them; they're cut off at the run's deadline too.
 *
 * `startedAt` is when the request that started the run began (posting, or "continue"), since the
 * function's own time limit counts from then; it defaults to now.
 */
export async function runRoom(roomId: string, deps: ReplyLoopDeps = defaultReplyDeps, { startedAt = Date.now() }: { startedAt?: number } = {}): Promise<void> {
  const runId = randomUUID()
  if (!(await tryAcquireRoomLock(roomId, runId))) return
  const timing = { ...RUN_TIMING, ...deps.timing }
  const deadlineAt = startedAt + timing.runDeadlineMs
  const run = deadline(deadlineAt - Date.now(), "the run reached its time limit")
  const sideJobs: Promise<void>[] = []
  let holding = true
  try {
    await closeInterruptedReplies(roomId, deps)
    for (;;) {
      const waiting = await findUnanswered(roomId)
      if (waiting.length) {
        const leftMs = deadlineAt - Date.now()
        if (leftMs < timing.minAnswerMs) {
          console.warn(
            `[jack] Run in room ${roomId} has ${Math.round(leftMs / 1000)} s left, too little for another answer; ` +
              `letting go with ${waiting.length} message(s) waiting (the next post or "continue" answers them)`
          )
          await releaseRoomLock(roomId, runId)
          holding = false
          return
        }
        if (!(await renewRoomLock(roomId, runId))) {
          holding = false // a newer run took over a lock it thought was stale; it answers from here
          return
        }
        await answer(roomId, waiting, deps, sideJobs, { runSignal: run.signal, deadlineAt, leftMs, replyDeadlineMs: timing.replyDeadlineMs })
        continue
      }

      await releaseRoomLock(roomId, runId)
      holding = false
      if (!(await hasUnanswered(roomId))) return
      if (!(await tryAcquireRoomLock(roomId, runId))) return // another run has it and will answer
      holding = true
    }
  } finally {
    run.clear()
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

/** The time an answer has: the run's deadline (as a signal and an instant), what's left of the run, and its own cap */
type AnswerTiming = { runSignal: AbortSignal; deadlineAt: number; leftMs: number; replyDeadlineMs: number }

/** One reply to every message in `waiting`, from the room's persona as it is now */
async function answer(roomId: string, waiting: JackMessageRow[], deps: ReplyLoopDeps, sideJobs: Promise<void>[], timing: AnswerTiming) {
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
  await deps.broadcast(roomId, { type: JACK_EVENT.created, message: toMessageView(reply), answers: waiting.map((m) => m.id) })

  const persona: JackRoomPersonaKey = isJackRoomPersona(reply.persona) ? reply.persona : "jack"
  const usage = new UsageTally(JACK_MODELS[persona].model)
  const startedAt = Date.now()
  let parts: JackToolPart[] = []

  // Cancelled at its own cap or the run's deadline, whichever comes first; told to wrap up a minute before
  const ownDeadline = deadline(timing.replyDeadlineMs, "the answer reached its time limit")
  const signal = AbortSignal.any([ownDeadline.signal, timing.runSignal])
  const availableMs = Math.min(timing.replyDeadlineMs, timing.leftMs)
  const limits: Partial<ReplyLimits> = {
    ...deps.limits,
    maxElapsedMs: Math.min(deps.limits?.maxElapsedMs ?? REPLY_LIMITS.maxElapsedMs, Math.max(0, availableMs - WRAP_UP_MARGIN_MS)),
  }

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
    produced = await produce(roomId, reply, persona, waiting, deps, stream, usage, { signal, limits }, (latest) => {
      parts = latest
    })
    status = produced.status
    parts = produced.parts
    // Past the run's deadline, skip sending what's left as deltas: the done event carries the whole text
    const ended = timing.runSignal.aborted ? stream.abort() : await stream.end()
    // The reply's own text, which is what streamed once any reset is applied
    result = { content: produced.text, streamSeq: ended.streamSeq }
  } catch (error) {
    console.error(`[jack] Reply ${reply.id} in room ${roomId} failed:`, error)
    status = "error"
    const sent = stream.abort()
    result = { content: produced?.text ?? sent.content, streamSeq: sent.streamSeq }
  } finally {
    ownDeadline.clear()
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
        // Saved after every call too (produce's onUsage); this is the same total, once more
        ...(usage.calls ? savedUsage(usage) : {}),
      },
      include: jackMessageInclude,
    })
  } catch (error) {
    // Viewers still get the ending; the next run closes the row as interrupted
    console.error(`[jack] Couldn't save reply ${reply.id}:`, error)
    final = { ...reply, ...result, status: "error", toolCalls: parts as unknown as Prisma.JsonValue }
  }
  await deps.broadcast(roomId, { type: JACK_EVENT.done, message: toMessageView(final) })

  // Stand names an untitled room after its first real answer (one Claude wrote, not a notice or a
  // refusal), in the background, if the run has time left; its call ends before the run's deadline
  const standLeftMs = timing.deadlineAt - Date.now()
  if (status === "done" && usage.calls > 0 && produced?.outcome !== "refusal" && !sideJobs.length && standLeftMs >= STAND_MIN_LEFT_MS) {
    const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { title: true } })
    const claude = deps.getClient()
    if (room?.title === null && claude) {
      const budget = await deps.budget()
      if (budget.spentUsd < budget.budgetUsd) {
        sideJobs.push(
          nameRoom({
            roomId,
            client: claude,
            broadcast: deps.broadcast,
            question: officerLines(waiting),
            answer: result.content,
            signal: timing.runSignal,
            timeoutMs: Math.min(STAND_TIMEOUT_MS, standLeftMs - STAND_MARGIN_MS),
          })
        )
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
  run: { signal: AbortSignal; limits: Partial<ReplyLimits> },
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
    // Tools run as the officer whose message started this reply: the newest one it answers
    ctx: { roomId, messageId: reply.id, actor: { userId: latest.authorUserId, displayName: latest.author?.displayName ?? FORMER_OFFICER } },
    onText: (text) => stream.write(text),
    onReset: (text) => stream.reset(text),
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
    // The spend so far goes on the reply after every call, so a reply cut off midway (or a function
    // that dies) still counts toward the meter and the budget
    onUsage: async (tally) => {
      await prisma.jackMessage.update({ where: { id: reply.id }, data: savedUsage(tally) })
    },
    usage,
    limits: run.limits,
    signal: run.signal,
  })
  return { text: out.text, status: out.status, outcome: out.outcome, parts: out.parts, toolCalls: out.toolCalls }
}

/** The messages a reply answered, as Stand reads them */
function officerLines(waiting: JackMessageRow[]): string {
  return waiting.map((m) => `${m.author?.displayName ?? FORMER_OFFICER}: ${m.content}`).join("\n")
}
