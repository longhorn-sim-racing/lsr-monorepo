import Anthropic from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { z } from "zod"
import type { JackDeltaEvent, JackDoneEvent, JackRoomEvent, JackToolEvent } from "@/lib/jack/types"
import { parseToolParts } from "@/lib/jack/parts"
import { fakeClaude, lastUserText, type FakeTurn } from "./fake-claude"
import type { FakeJackDb } from "./jack-test-db"
import type { JackTool } from "./tools/types"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})

import { prisma } from "@/server/db"
import { runRoom, type ReplyLoopDeps } from "./reply-loop"
import { setRoomPersona } from "./rooms"
import { releaseRoomLock, renewRoomLock, ROOM_LOCK_STALE_MS, tryAcquireRoomLock } from "./room-lock"

const db = prisma as unknown as FakeJackDb
const MINUTE = 60_000

/** A broadcaster that records what each room was sent */
function fakeBroadcaster() {
  const sent: { roomId: string; event: JackRoomEvent }[] = []
  const broadcast = vi.fn(async (roomId: string, event: JackRoomEvent) => {
    sent.push({ roomId, event })
  })
  const of = <T extends JackRoomEvent["type"]>(type: T) =>
    sent.map((s) => s.event).filter((e): e is Extract<JackRoomEvent, { type: T }> => e.type === type)
  return { broadcast, sent, of }
}

/**
 * A fake Claude that answers as the room's persona with the officer turn it was sent, streamed in
 * small pieces about 100 ms apart (so a reply takes a few seconds, on fake timers)
 */
function echoClaude() {
  return fakeClaude(
    (params: BetaMessageStreamParams): FakeTurn => ({
      text: `${params.model === "claude-opus-5-5" ? "Lift" : "Jack"} here. You asked:
${lastUserText(params)}`,
    }),
    undefined,
    { chunkSize: 2, chunkDelayMs: 100 }
  )
}

/** Runs the loop on fake timers, so the stream's pacing and the 150 ms batching happen instantly */
async function onFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  const pending = work()
  await vi.runAllTimersAsync()
  return pending
}

let room: ReturnType<FakeJackDb["addRoom"]>
let radio: ReturnType<typeof fakeBroadcaster>
let claude: ReturnType<typeof fakeClaude>
let deps: ReplyLoopDeps

function ask(content: string, userId = "officer-gray") {
  return db.addMessage({ roomId: room.id, authorUserId: userId, content })
}

const replies = () => db.state.messages.filter((m) => m.kind === "assistant")
const unanswered = () => db.state.messages.filter((m) => m.kind === "user" && m.answeredById === null)
const textOf = (deltas: JackDeltaEvent[], messageId: string) =>
  deltas
    .filter((d) => d.messageId === messageId)
    .map((d) => d.text)
    .join("")

beforeEach(() => {
  vi.useFakeTimers()
  db.reset()
  db.state.users.set("officer-gray", "Gray")
  db.state.users.set("officer-dylan", "Dylan")
  room = db.addRoom({ title: "LSC questions" }) // titled, so Stand stays out of it unless a test wants him
  radio = fakeBroadcaster()
  claude = echoClaude()
  deps = {
    broadcast: radio.broadcast,
    getClient: () => claude.client,
    tools: [],
    budget: async () => ({ month: "October", spentUsd: 3.2, budgetUsd: 200 }),
  }
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe("room lock", () => {
  it("goes to one run at a time and only its holder releases it", async () => {
    expect(await tryAcquireRoomLock(room.id, "run-a")).toBe(true)
    expect(await tryAcquireRoomLock(room.id, "run-b")).toBe(false)

    await releaseRoomLock(room.id, "run-b")
    expect(db.room(room.id).runId).toBe("run-a")

    await releaseRoomLock(room.id, "run-a")
    expect(db.room(room.id)).toMatchObject({ runId: null, runStartedAt: null })
    expect(await tryAcquireRoomLock(room.id, "run-b")).toBe(true)
  })

  it("lets exactly one of several simultaneous tries win", async () => {
    const results = await Promise.all(["a", "b", "c", "d"].map((id) => tryAcquireRoomLock(room.id, `run-${id}`)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("takes over a lock left by a run that died, but not a fresh one", async () => {
    const now = new Date()
    db.room(room.id).runId = "dead-run"
    db.room(room.id).runStartedAt = new Date(now.getTime() - ROOM_LOCK_STALE_MS + MINUTE)
    expect(await tryAcquireRoomLock(room.id, "run-a", now)).toBe(false)

    db.room(room.id).runStartedAt = new Date(now.getTime() - ROOM_LOCK_STALE_MS - MINUTE)
    expect(await tryAcquireRoomLock(room.id, "run-a", now)).toBe(true)
    expect(db.room(room.id).runId).toBe("run-a")
  })

  it("renews only for its holder", async () => {
    await tryAcquireRoomLock(room.id, "run-a")
    expect(await renewRoomLock(room.id, "run-a")).toBe(true)
    expect(await renewRoomLock(room.id, "run-b")).toBe(false)
  })
})

describe("runRoom", () => {
  it("streams one reply to an officer's message: created, numbered deltas, done with the full text", async () => {
    const question = ask("How many LSC applications are there?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(1)
    const [reply] = replies()
    const expected = reply.content
    expect(expected).toMatch(/^Jack here/)
    expect(expected).toContain("Gray: How many LSC applications are there?")
    expect(reply).toMatchObject({ persona: "jack", status: "done", model: "claude-sonnet-5-5" })
    expect(db.state.messages.find((m) => m.id === question.id)?.answeredById).toBe(reply.id)

    const types = radio.sent.map((s) => s.event.type)
    expect(types[0]).toBe("message.created")
    expect(types.at(-1)).toBe("message.done")
    const deltas = radio.of("message.delta")
    expect(deltas.length).toBeGreaterThan(5) // it streams, in ~150 ms batches over a few seconds
    expect(deltas.map((d) => d.seq)).toEqual(deltas.map((_, i) => i + 1))
    expect(textOf(deltas, reply.id)).toBe(expected)

    const done = radio.of("message.done")[0] as JackDoneEvent
    expect(done.message).toMatchObject({ id: reply.id, status: "done", content: expected, streamSeq: deltas.length })
    expect(reply.streamSeq).toBe(deltas.length)
    expect(radio.sent.every((s) => s.roomId === room.id)).toBe(true)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("saves the partial reply about once a second while it streams", async () => {
    ask("Charges this month?")
    const saves: { content: string; streamSeq: number }[] = []
    db.state.hook = (op, { data }) => {
      if (op === "jackMessage.update" && data && "streamSeq" in data && !("status" in data)) {
        saves.push({ content: data.content as string, streamSeq: data.streamSeq as number })
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    const deltas = radio.of("message.delta")
    expect(saves.length).toBeGreaterThanOrEqual(2)
    expect(saves.length).toBeLessThan(deltas.length / 3)
    // each save is the text through exactly the delta it names
    for (const save of saves) expect(save.content).toBe(deltas.slice(0, save.streamSeq).map((d) => d.text).join(""))
  })

  it("answers messages that arrive mid-answer together in the next reply", async () => {
    ask("Is GM 1 on the calendar?")
    let queued = false
    db.state.hook = (op) => {
      // The first reply is streaming: two more questions come in
      if (!queued && op === "jackMessage.update" && replies().length === 1) {
        queued = true
        ask("Who started a checkout and didn't pay?", "officer-dylan")
        ask("And charges this month?")
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(2)
    const second = replies()[1]
    expect(second.content).toContain("Dylan: Who started a checkout and didn't pay?")
    expect(second.content).toContain("Gray: And charges this month?")
    expect(second.content).not.toContain("GM 1")
    expect(unanswered()).toHaveLength(0)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("leaves nothing unanswered when a message lands just before the run lets go of the lock", async () => {
    ask("How many are paid?")
    let posted = false
    let posterGotLock: boolean | null = null
    db.state.hook = async (op, { data }) => {
      if (!posted && op === "jackRoom.updateMany" && data?.runId === null) {
        // The run found nothing waiting and is releasing. Right before that, an officer posts:
        // their message is saved, but their try for the lock finds it still taken
        posted = true
        ask("Which rounds have results uploaded?", "officer-dylan")
        const hook = db.state.hook
        db.state.hook = null
        posterGotLock = await tryAcquireRoomLock(room.id, "poster-run")
        db.state.hook = hook
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(posterGotLock).toBe(false)
    expect(replies()).toHaveLength(2)
    expect(replies()[1].content).toContain("Dylan: Which rounds have results uploaded?")
    expect(unanswered()).toHaveLength(0)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("answers each message once when the poster's run starts right after the release", async () => {
    ask("How many LSC applications are there?")
    let posterRun: Promise<void> | null = null
    db.state.hook = (op) => {
      if (!posterRun && op === "jackMessage.findFirst") {
        // The first run has just released and is about to look again; a second officer posts now
        ask("How many are paid?", "officer-dylan")
        posterRun = runRoom(room.id, deps)
      }
    }

    await onFakeTimers(async () => {
      await runRoom(room.id, deps)
      await posterRun
    })

    expect(posterRun).not.toBeNull()
    expect(replies()).toHaveLength(2)
    const answeredBy = db.state.messages.filter((m) => m.kind === "user").map((m) => m.answeredById)
    expect(new Set(answeredBy).size).toBe(2) // each question got its own reply, none twice
    expect(unanswered()).toHaveLength(0)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("runs once when two posts start runs at the same moment", async () => {
    ask("Charges this month?")
    ask("And refunds?", "officer-dylan")

    await onFakeTimers(() => Promise.all([runRoom(room.id, deps), runRoom(room.id, deps)]))

    expect(replies()).toHaveLength(1)
    expect(replies()[0].content).toContain("Gray: Charges this month?")
    expect(replies()[0].content).toContain("Dylan: And refunds?")
    expect(unanswered()).toHaveLength(0)
  })

  it("does nothing while another run holds a fresh lock", async () => {
    ask("Anyone there?")
    db.room(room.id).runId = "other-run"
    db.room(room.id).runStartedAt = new Date()

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(0)
    expect(radio.broadcast).not.toHaveBeenCalled()
    expect(db.room(room.id).runId).toBe("other-run")
  })

  it("taking over a dead run's lock closes its half-streamed reply as an error, then answers", async () => {
    const stuck = db.addMessage({ roomId: room.id, persona: "jack", status: "streaming", content: "Jack he", streamSeq: 3 })
    ask("Still there?")
    db.room(room.id).runId = "dead-run"
    db.room(room.id).runStartedAt = new Date(Date.now() - ROOM_LOCK_STALE_MS - MINUTE)

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(db.state.messages.find((m) => m.id === stuck.id)).toMatchObject({ status: "error", content: "Jack he" })
    const closed = radio.of("message.done").find((e) => e.message.id === stuck.id)
    expect(closed?.message.status).toBe("error")
    expect(replies().filter((m) => m.status === "done")).toHaveLength(1)
    expect(unanswered()).toHaveLength(0)
  })

  it("ends a reply as an error when saving it fails, and keeps going", async () => {
    ask("First question")
    let failed = false
    db.state.hook = (op, { data }) => {
      if (!failed && op === "jackMessage.update" && data && !("status" in data)) {
        failed = true
        throw new Error("connection reset")
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(1)
    expect(replies()[0].status).toBe("error")
    expect(radio.of("message.done")[0].message.status).toBe("error")
    expect(unanswered()).toHaveLength(0) // claimed, so it isn't retried forever
    expect(db.room(room.id).runId).toBeNull()
  })

  it("stops without answering when its lock was taken over", async () => {
    ask("Hello?")
    db.state.hook = (op, { data }) => {
      // Between taking the lock and answering, another run takes it over
      if (op === "jackRoom.updateMany" && data && "runStartedAt" in data && !("runId" in data)) {
        db.room(room.id).runId = "newer-run"
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(0)
    expect(db.room(room.id).runId).toBe("newer-run")
  })

  it("answers as the room's persona", async () => {
    db.room(room.id).persona = "lift"
    ask("Hard one: which drivers improved most this season?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(1)
    expect(replies()[0]).toMatchObject({ kind: "assistant", persona: "lift", status: "done" })
    expect(replies()[0].content).toMatch(/^Lift here/)
    const created = radio.of("message.created")[0]
    expect(created.message.author).toEqual({ kind: "assistant", persona: "lift" })
  })

  it("doesn't answer system notes", async () => {
    db.addMessage({ roomId: room.id, kind: "system", authorUserId: "officer-gray", content: "Gray switched this room to Lift" })

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(0)
    expect(radio.broadcast).not.toHaveBeenCalled()
  })
})

describe("setRoomPersona", () => {
  const gray = { id: "officer-gray", displayName: "Gray" }

  it("switches the room, posts who did it, and tells the room", async () => {
    const result = await setRoomPersona(room.id, gray, "lift", radio.broadcast)

    expect(result).toMatchObject({ changed: true, before: "jack", room: { id: room.id, persona: "lift" } })
    expect(db.room(room.id).persona).toBe("lift")
    const notes = db.state.messages.filter((m) => m.kind === "system")
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ content: "Gray switched this room to Lift", authorUserId: "officer-gray", persona: null })
    expect(radio.sent.map((s) => s.event.type)).toEqual(["room.updated", "message.created"])
    expect(radio.of("message.created")[0].message.author).toEqual({ kind: "system" })
  })

  it("does nothing when the room already has that persona", async () => {
    const result = await setRoomPersona(room.id, gray, "jack", radio.broadcast)

    expect(result).toMatchObject({ changed: false, room: { persona: "jack" } })
    expect(db.state.messages).toHaveLength(0)
    expect(radio.broadcast).not.toHaveBeenCalled()
  })

  it("posts one note when two officers switch at once", async () => {
    const dylan = { id: "officer-dylan", displayName: "Dylan" }
    const results = await Promise.all([
      setRoomPersona(room.id, gray, "lift", radio.broadcast),
      setRoomPersona(room.id, dylan, "lift", radio.broadcast),
    ])

    expect(results.filter((r) => r?.changed)).toHaveLength(1)
    expect(db.state.messages.filter((m) => m.kind === "system")).toHaveLength(1)
  })

  it("is null for a room that doesn't exist", async () => {
    expect(await setRoomPersona("room-missing", gray, "lift", radio.broadcast)).toBeNull()
  })
})

describe("replies from Claude", () => {
  function lookupTool(seen: { actor?: unknown } = {}): JackTool<{ what: string }> {
    return {
      name: "lookup",
      description: "Looks something up.",
      input: z.object({ what: z.string() }),
      run: async ({ what }, ctx) => {
        seen.actor = ctx.actor
        return { forModel: `${what}: 13`, label: `Looked up ${what} (13)`, displays: [{ kind: "note", text: "13" }] }
      },
    }
  }

  it("says the API key is missing instead of calling Claude", async () => {
    deps.getClient = () => null
    ask("How many members?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0]).toMatchObject({
      status: "done",
      content: "Jack isn't connected yet: an admin needs to add the Anthropic API key.",
      model: null,
      costUsd: null,
    })
    expect(radio.of("message.done")[0].message.content).toMatch(/isn't connected yet/)
    expect(unanswered()).toHaveLength(0)
  })

  it("says the monthly budget is used up instead of calling Claude", async () => {
    deps.budget = async () => ({ month: "October", spentUsd: 200.4, budgetUsd: 200 })
    db.room(room.id).persona = "lift"
    ask("Hard question")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(claude.calls).toHaveLength(0)
    expect(replies()[0]).toMatchObject({ status: "done", persona: "lift", costUsd: null })
    expect(replies()[0].content).toBe(
      "Lift's monthly budget is used up: $200.40 of $200 spent in October. Lift answers again next month, or an admin can raise JACK_MONTHLY_BUDGET_USD."
    )
  })

  it("records the model, tokens and cost on the reply", async () => {
    claude = fakeClaude([{ text: "42.", usage: { input: 1_000, output: 300, cacheRead: 8_000, cacheWrite: 2_000 } }])
    ask("How many members?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 3_000, outputTokens: 300, cacheReadTokens: 8_000 })
    // $2/M uncached in, $2.50/M cache writes, $0.20/M cache reads, $10/M out
    expect(reply.costUsd).toBeCloseTo((1_000 * 2 + 2_000 * 2.5 + 8_000 * 0.2 + 300 * 10) / 1e6, 6)
  })

  it("streams tool calls to the room in order, after the text before them, and saves them on the reply", async () => {
    deps.tools = [lookupTool()]
    claude = fakeClaude(
      [{ text: "Let me check that.", tools: [{ id: "toolu_1", name: "lookup", input: { what: "applications" } }] }, { text: "There are 13 (lookup)." }],
      undefined,
      { chunkSize: 3, chunkDelayMs: 40 }
    )
    const saved: unknown[] = []
    db.state.hook = (op, { data }) => {
      if (op === "jackMessage.update" && data && "toolCalls" in data && !("status" in data)) saved.push(structuredClone(data.toolCalls))
    }
    ask("How many LSC applications?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.content).toBe("Let me check that.\n\nThere are 13 (lookup).")
    const parts = parseToolParts(reply.toolCalls)
    expect(parts).toEqual([
      expect.objectContaining({ id: "toolu_1", name: "lookup", status: "done", label: "Looked up applications (13)", at: "Let me check that.".length }),
    ])

    // live: running, running with input, done; each after the deltas carrying the text before it
    const tools = radio.sent.map((s, index) => ({ event: s.event, index })).filter((s) => s.event.type === "message.tool")
    expect(tools.map((t) => (t.event as JackToolEvent).part.status)).toEqual(["running", "running", "done"])
    for (const { event, index } of tools) {
      const before = radio.sent
        .slice(0, index)
        .map((s) => s.event)
        .filter((e): e is JackDeltaEvent => e.type === "message.delta")
        .map((d) => d.text)
        .join("")
      expect(before.length).toBeGreaterThanOrEqual((event as JackToolEvent).part.at)
      expect((event as JackToolEvent).messageId).toBe(reply.id)
    }
    // saved mid-reply too, for viewers who open the room while it runs
    expect(saved.length).toBeGreaterThanOrEqual(2)
    expect(radio.of("message.done")[0].message.tools).toEqual(parts)
    expect(radio.sent.at(-1)?.event.type).toBe("message.done")
  })

  it("runs tools as the officer whose message is newest", async () => {
    const seen: { actor?: unknown } = {}
    deps.tools = [lookupTool(seen)]
    claude = fakeClaude([{ tools: [{ name: "lookup", input: { what: "events" } }] }, { text: "Done." }])
    ask("Events?")
    ask("And GM 1?", "officer-dylan")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(seen.actor).toEqual({ userId: "officer-dylan", displayName: "Dylan" })
  })

  it("sends the room's history: earlier exchanges, tool notes, a persona switch, and several officers in one turn", async () => {
    const q1 = ask("How many members?")
    const r1 = db.addMessage({
      roomId: room.id,
      persona: "jack",
      model: "claude-sonnet-5-5",
      content: "There are 42 members.",
      toolCalls: [{ id: "t1", name: "run_sql", label: "Ran a query (1 row)", status: "done", at: 0, input: { sql: 'select count(*) from "User"' }, displays: [] }],
    })
    db.state.messages.find((m) => m.id === q1.id)!.answeredById = r1.id
    db.addMessage({ roomId: room.id, kind: "system", authorUserId: "officer-gray", content: "Gray switched this room to Lift" })
    db.room(room.id).persona = "lift"
    ask("Which of them raced this season?", "officer-dylan")
    ask("And how many are new?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [params] = claude.calls
    expect(params.model).toBe("claude-opus-5-5")
    expect((params.system as { text: string }[])[0].text).toMatch(/^You are Lift/)
    expect(params.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(params.messages[0].content).toMatch(/^\[.+ CT\]\nGray: How many members\?$/)
    expect(params.messages[1].content).toBe('There are 42 members.\n\n[Tools used: run_sql {"sql":"select count(*) from \\"User\\""} → Ran a query (1 row)]')
    expect(params.messages[2].content).toMatch(
      /^\[.+ CT\]\n\(Room note: Gray switched this room to Lift\)\nDylan: Which of them raced this season\?\nGray: And how many are new\?$/
    )
    expect(replies().at(-1)).toMatchObject({ persona: "lift", model: "claude-opus-5-5" })
  })

  it("ends as an error, with a plain message, when Claude can't be reached", async () => {
    claude = fakeClaude([{ text: "Partial", error: new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers()) }])
    ask("Charges this month?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0].status).toBe("error")
    expect(replies()[0].content).toMatch(/too many requests/)
    expect(radio.of("message.done")[0].message.status).toBe("error")
    expect(unanswered()).toHaveLength(0)
  })
})

describe("Stand names untitled rooms", () => {
  beforeEach(() => {
    db.room(room.id).title = null
  })

  it("names the room after its first answer, saves Stand's cost on a note, and tells the room", async () => {
    claude = fakeClaude([{ text: "There are 13 applications." }], [{ text: '"LSC Application Count."', usage: { input: 120, output: 40 } }])
    ask("How many LSC applications are there?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(db.room(room.id).title).toBe("LSC Application Count")
    const note = db.state.messages.find((m) => m.kind === "system")
    expect(note).toMatchObject({ content: "Stand named this room “LSC Application Count”", model: "claude-haiku-5-5", persona: null, inputTokens: 120, outputTokens: 40 })
    expect(note?.costUsd).toBeCloseTo((120 * 0.1 + 40 * 0.5) / 1e6, 9)

    const [request] = claude.creates
    expect(request).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 1_024, output_config: { effort: "low" } })
    expect(request).not.toHaveProperty("fallbacks") // Haiku 5.5 has no server-side fallback
    expect(JSON.stringify(request.messages)).toContain("Gray: How many LSC applications are there?")
    expect(JSON.stringify(request.messages)).toContain("There are 13 applications.")

    const types = radio.sent.map((s) => s.event.type)
    expect(types.slice(-3)).toEqual(["message.done", "room.updated", "message.created"])
    expect(radio.of("room.updated")[0].room.title).toBe("LSC Application Count")
  })

  it("names a room once", async () => {
    claude = fakeClaude(() => ({ text: "An answer." }))
    ask("First question")
    await onFakeTimers(() => runRoom(room.id, deps))
    ask("Second question")
    await onFakeTimers(() => runRoom(room.id, deps))

    expect(claude.creates).toHaveLength(1)
    expect(db.state.messages.filter((m) => m.kind === "system")).toHaveLength(1)
  })

  it("leaves the room untitled, quietly, when Stand fails", async () => {
    claude = fakeClaude([{ text: "An answer." }], [{ error: new Error("overloaded") }])
    ask("A question")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(db.room(room.id).title).toBeNull()
    expect(replies()[0].status).toBe("done")
    expect(db.state.messages.filter((m) => m.kind === "system")).toHaveLength(0)
    expect(console.error).toHaveBeenCalled()
  })

  it("doesn't run for a reply that wasn't an answer", async () => {
    deps.getClient = () => null
    ask("A question")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(db.room(room.id).title).toBeNull()
  })

  it("doesn't run when the budget is used up", async () => {
    let calls = 0
    deps.budget = async () => ({ month: "October", spentUsd: calls++ === 0 ? 199.99 : 200, budgetUsd: 200 })
    ask("A question")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0].content).toMatch(/^Jack here/)
    expect(claude.creates).toHaveLength(0)
  })
})
