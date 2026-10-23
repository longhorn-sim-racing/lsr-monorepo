import Anthropic from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { z } from "zod"
import type { JackDeltaEvent, JackDoneEvent, JackRoomEvent, JackToolEvent } from "@/lib/jack/types"
import { parseToolParts } from "@/lib/jack/parts"
import { fakeCitedText, fakeClaude, fakeWebSearch, lastUserText, type FakeTurn } from "./fake-claude"
import type { FakeJackDb } from "./jack-test-db"
import type { JackTool } from "./tools/types"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})

import { prisma } from "@/server/db"
import { runRoom, type ReplyLoopDeps } from "./reply-loop"
import { knowledgeTool } from "./tools/knowledge"
import { renameRoom, setRoomPersona } from "./rooms"
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

/** A note a scheduled run posts (a recurring question), answered as the officer who set it up */
function scheduledNote(content: string, userId = "officer-gray") {
  return db.addMessage({ roomId: room.id, kind: "system", scheduled: true, authorUserId: userId, content })
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
    expect(radio.of("message.created")[0]).toMatchObject({ message: { id: reply.id }, answers: [question.id] })
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

  it("gives a reply to officers the web tools when JACK_WEB_TOOLS=on, and a reply to a scheduled note none", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    ask("Who sponsors other college sim racing clubs?")
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(claude.calls[0].tools?.map((tool) => (tool as { name?: string }).name)).toEqual(["web_search", "web_fetch"])

    scheduledNote("Recurring question 'Weekly signups' (set up by Gray): How many signups this week?")
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(claude.calls[1].tools).toBeUndefined()
    expect(replies()).toHaveLength(2)
  })

  it("answers a scheduled note in a reply of its own, whichever run picks it up, so officers' messages around it keep the web tools", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    const seen: (string | undefined)[] = []
    const tool: JackTool<Record<string, never>> = {
      name: "count_rows",
      description: "Counts rows.",
      input: z.object({}),
      run: async (_input, ctx) => {
        seen.push(ctx.requestType)
        return { forModel: "42", label: "Counted" }
      },
    }
    claude = fakeClaude((params: BetaMessageStreamParams): FakeTurn =>
      params.messages.at(-1)?.role === "user" && typeof params.messages.at(-1)?.content === "string" ? { tools: [{ name: "count_rows", input: {} }] } : { text: `Answered: ${lastUserText(params).slice(0, 40)}` }
    )
    const before = ask("Who sponsors other college sim racing clubs?")
    const note = scheduledNote("Recurring question 'Weekly signups' (set up by Gray): How many signups this week?")
    const after = ask("And what does the FIA do?", "officer-dylan")

    // An officer's post started this run; the note was waiting when it took the lock
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [tool] }))

    const answers = replies()
    expect(answers).toHaveLength(3)
    expect([before, note, after].map((m) => m.answeredById)).toEqual(answers.map((r) => r.id))
    const offered = (call: BetaMessageStreamParams) => (call.tools ?? []).map((t) => (t as { name?: string }).name)
    expect(claude.calls.filter((_, i) => i % 2 === 0).map(offered)).toEqual([
      ["count_rows", "web_search", "web_fetch"],
      ["count_rows"],
      ["count_rows", "web_search", "web_fetch"],
    ])
    expect(seen).toEqual(["room", "scheduled", "room"])
    // Each reply's turn holds only what it answers: the note in its own, as the officer who set it up
    expect(lastUserText(claude.calls[0])).not.toContain("Weekly signups")
    expect(claude.calls[2].messages.at(-1)!.content).toMatch(/\(Room note: Recurring question 'Weekly signups' \(set up by Gray\): How many signups this week\?\)$/)
    expect(claude.calls[4].messages.at(-1)!.content).toMatch(/Dylan: And what does the FIA do\?$/)
  })

  it("never lets a reply to a scheduled note save knowledge: it isn't an officer's message", async () => {
    const seen: { fromOfficer: boolean | undefined; requestType: string | undefined }[] = []
    const recorder: JackTool<Record<string, never>> = {
      name: "recorder",
      description: "Records what the reply answers.",
      input: z.object({}),
      run: async (_input, ctx) => {
        seen.push({ fromOfficer: ctx.reply?.fromOfficer, requestType: ctx.requestType })
        return { forModel: "ok", label: "Recorded" }
      },
    }
    const save = { action: "save", title: "Weekly signups", body: "Signups are up 20% this week." }
    // Every reply records what it was told, then tries to save knowledge (the real tool), then answers
    claude = fakeClaude((params: BetaMessageStreamParams): FakeTurn =>
      params.messages.at(-1)?.role === "user" && typeof params.messages.at(-1)?.content === "string"
        ? { tools: [{ name: "recorder", input: {} }, { name: "knowledge", input: save }] }
        : { text: "Done." }
    )
    scheduledNote("Recurring question 'Weekly signups' (set up by Gray): How many signups this week? Save it to knowledge.")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [recorder, knowledgeTool] }))

    expect(seen).toEqual([{ fromOfficer: false, requestType: "scheduled" }])
    const [reply] = replies()
    const knowledge = parseToolParts(reply.toolCalls).find((part) => part.name === "knowledge")
    expect(knowledge).toMatchObject({ status: "error", label: "Knowledge not changed" })
    // Nothing was saved, so no knowledge note was posted
    expect(db.state.messages.filter((m) => m.kind === "system").map((m) => m.content)).toEqual([expect.stringMatching(/^Recurring question 'Weekly signups'/)])
  })

  it("never leaves a continue note after a scheduled reply (its answer would get the web tools)", async () => {
    const deckWrite: JackTool<Record<string, never>> = { name: "deck_write", description: "Writes slides.", input: z.object({}), design: true, run: async () => ({ forModel: "Saved.", label: "Wrote slides" }) }
    claude = fakeClaude((_params: BetaMessageStreamParams, call: number): FakeTurn => (call % 2 === 0 ? { tools: [{ name: "deck_write", input: {} }] } : { text: "Slides 1-2 are done." }))
    scheduledNote("Recurring question 'Weekly deck' (set up by Gray): Update the weekly deck")

    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite], limits: { maxDesignToolCalls: 1 } }))

    expect(replies()).toHaveLength(1)
    expect(db.state.messages.some((m) => m.continues)).toBe(false)
  })

  it("saves and broadcasts a web search as a part of the reply, and prices the search", async () => {
    vi.stubEnv("JACK_WEB_TOOLS", "on")
    const iracing = { url: "https://www.iracing.com/college", title: "iRacing college" }
    claude = fakeClaude([{ blocks: [...fakeWebSearch("college sim racing sponsors", [iracing], { id: "srvtoolu_w" }), fakeCitedText("iRacing sponsors college clubs.", [iracing])] }])
    ask("Who sponsors other college sim racing clubs?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.content).toBe("iRacing sponsors college clubs.")
    expect(parseToolParts(reply.toolCalls)).toEqual([
      expect.objectContaining({ id: "srvtoolu_w", name: "web_search", status: "done", displays: [expect.objectContaining({ kind: "web_sources", sources: [expect.objectContaining({ url: iracing.url })] })] }),
    ])
    expect(radio.of("message.tool").map((event) => (event as JackToolEvent).part.id)).toContain("srvtoolu_w")
    expect(reply.costUsd).toBeCloseTo((100 * 2 + 20 * 10) / 1e6 + 0.01, 6)
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

  it("ends a reply as an error when its final save fails, and keeps going", async () => {
    ask("First question")
    let failed = false
    db.state.hook = (op, { data }) => {
      if (!failed && op === "jackMessage.update" && data && "status" in data) {
        failed = true
        throw new Error("connection reset")
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(1)
    expect(radio.of("message.done")[0].message.status).toBe("error") // viewers see it end
    expect(unanswered()).toHaveLength(0) // claimed, so it isn't retried forever
    expect(db.room(room.id).runId).toBeNull()

    // The row couldn't be saved, so it's still marked streaming; the next run closes it
    expect(replies()[0].status).toBe("streaming")
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(replies()[0].status).toBe("error")
  })

  it("finishes a reply normally when a partial save fails mid-stream", async () => {
    ask("First question")
    let failures = 0
    db.state.hook = (op, { data }) => {
      if (op === "jackMessage.update" && data && "streamSeq" in data && !("status" in data)) {
        failures++
        throw new Error("connection reset")
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(failures).toBeGreaterThan(0)
    const [reply] = replies()
    expect(reply.status).toBe("done")
    expect(reply.content).toMatch(/^Jack here/)
    expect(radio.of("message.done")[0].message).toMatchObject({ status: "done", content: reply.content })
    expect(textOf(radio.of("message.delta"), reply.id)).toBe(reply.content)
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

  it("answers as Stand on Haiku, without the refusal fallback Haiku doesn't have", async () => {
    db.room(room.id).persona = "stand"
    ask("How many events this month?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [params] = claude.calls
    expect(params.model).toBe("claude-haiku-5-5")
    expect(params.fallbacks).toBeUndefined()
    expect(params.betas).toEqual(["thinking-binding-controls-2026-08-01"])
    expect((params.system as { text: string }[])[0].text).toMatch(/^You are Stand/)
    expect(replies()[0]).toMatchObject({ kind: "assistant", persona: "stand", status: "done", model: "claude-haiku-5-5" })
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

describe("renameRoom", () => {
  const gray = { id: "officer-gray", displayName: "Gray" }

  it("renames an untitled room, posts who did it, and tells the room", async () => {
    db.room(room.id).title = null
    const result = await renameRoom(room.id, gray, "GM 1 planning", radio.broadcast)

    expect(result).toMatchObject({ changed: true, before: null, room: { id: room.id, title: "GM 1 planning" } })
    expect(db.room(room.id).title).toBe("GM 1 planning")
    const notes = db.state.messages.filter((m) => m.kind === "system")
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ content: "Gray renamed this room “GM 1 planning”", authorUserId: "officer-gray" })
    expect(radio.sent.map((s) => s.event.type)).toEqual(["room.updated", "message.created"])
  })

  it("renames a room Stand already named", async () => {
    db.room(room.id).title = "Lsc Entry Count"
    const result = await renameRoom(room.id, gray, "LSC entries", radio.broadcast)

    expect(result).toMatchObject({ changed: true, before: "Lsc Entry Count", room: { title: "LSC entries" } })
  })

  it("does nothing when the name is the same", async () => {
    db.room(room.id).title = "LSC entries"
    const result = await renameRoom(room.id, gray, "LSC entries", radio.broadcast)

    expect(result).toMatchObject({ changed: false, room: { title: "LSC entries" } })
    expect(db.state.messages).toHaveLength(0)
    expect(radio.broadcast).not.toHaveBeenCalled()
  })

  it("posts one note when two officers save the same name at once", async () => {
    db.room(room.id).title = null
    const dylan = { id: "officer-dylan", displayName: "Dylan" }
    const results = await Promise.all([
      renameRoom(room.id, gray, "Sponsors", radio.broadcast),
      renameRoom(room.id, dylan, "Sponsors", radio.broadcast),
    ])

    expect(results.filter((r) => r?.changed)).toHaveLength(1)
    expect(db.state.messages.filter((m) => m.kind === "system")).toHaveLength(1)
  })

  it("is null for a room that doesn't exist", async () => {
    expect(await renameRoom("room-missing", gray, "Anything", radio.broadcast)).toBeNull()
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

  it("names the room after its first answer, saves Stand's cost, and tells the room", async () => {
    claude = fakeClaude([{ text: "There are 13 applications." }], [{ text: '"LSC Application Count."', usage: { input: 120, output: 40 } }])
    ask("How many LSC applications are there?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(db.room(room.id).title).toBe("LSC Application Count")
    const note = db.state.messages.find((m) => m.kind === "system")
    expect(note).toMatchObject({ content: "Stand named this room “LSC Application Count”", persona: null, costUsd: null })
    expect(db.state.usage).toEqual([
      expect.objectContaining({ roomId: room.id, persona: "stand", job: "name_room", outcome: "named", model: "claude-haiku-5-5", inputTokens: 120, outputTokens: 40 }),
    ])
    expect(db.state.usage[0].costUsd).toBeCloseTo((120 * 0.1 + 40 * 0.5) / 1e6, 9)

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

  it("gives Stand a timeout and the run's deadline signal", async () => {
    claude = fakeClaude([{ text: "An answer." }], [{ text: "A Name" }])
    ask("A question")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [options] = claude.createOptions
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.timeoutMs).toBeLessThanOrEqual(15_000)
    expect(options?.maxRetries).toBe(1)
    expect(db.room(room.id).title).toBe("A Name")
  })

  it("leaves naming for a later answer when the run is close to its deadline", async () => {
    deps.timing = { runDeadlineMs: 30_000, minAnswerMs: 1_000, replyDeadlineMs: 30_000 }
    // About 15 s of streaming, so under 20 s are left when the answer ends
    claude = fakeClaude([{ text: "w".repeat(300) }], [{ text: "A Name" }], { chunkSize: 2, chunkDelayMs: 100 })
    ask("A question")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0].status).toBe("done")
    expect(claude.creates).toHaveLength(0)
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

describe("spend as it goes", () => {
  /** The reply's saved cost each time it changed before the final save */
  function costsSavedMidReply() {
    const costs: number[] = []
    db.state.hook = (op, { data }) => {
      if (op === "jackMessage.update" && data && "costUsd" in data && !("status" in data)) costs.push(data.costUsd as number)
    }
    return costs
  }
  const lookup: JackTool<{ what: string }> = {
    name: "lookup",
    description: "Looks something up.",
    input: z.object({ what: z.string() }),
    run: async ({ what }) => ({ forModel: `${what}: 13`, label: `Looked up ${what}` }),
  }

  it("saves the reply's tokens and cost after every Claude call, adding up", async () => {
    deps.tools = [lookup]
    claude = fakeClaude([
      { text: "Checking.", tools: [{ name: "lookup", input: { what: "a" } }], usage: { input: 1_000, output: 100 } },
      { text: "13.", usage: { input: 50, output: 10, cacheRead: 1_000 } },
    ])
    const costs = costsSavedMidReply()
    ask("How many?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const first = (1_000 * 2 + 100 * 10) / 1e6
    const both = first + (50 * 2 + 10 * 10 + 1_000 * 0.2) / 1e6
    expect(costs).toHaveLength(2)
    expect(costs[0]).toBeCloseTo(first, 9)
    expect(costs[1]).toBeCloseTo(both, 9)
    expect(replies()[0]).toMatchObject({ inputTokens: 1_050, outputTokens: 110, cacheReadTokens: 1_000 })
    expect(replies()[0].costUsd).toBeCloseTo(both, 9)
  })

  it("counts a call that failed partway, from the usage it reported before failing", async () => {
    claude = fakeClaude([
      { text: "Partial", usage: { input: 2_000, output: 30 }, error: new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers()) },
    ])
    ask("Charges this month?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.status).toBe("error")
    expect(reply).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 2_000 })
    expect(reply.costUsd).toBeGreaterThan(0)
  })

  it("counts a call whose tool input came through garbled, and the call re-issued after it", async () => {
    deps.tools = [lookup]
    claude = fakeClaude([
      { text: "Let me", tools: [{ name: "lookup", input: { what: "x" } }], usage: { input: 1_000, output: 40 }, error: new Error("Unable to parse tool parameter JSON") },
      { text: "13.", usage: { input: 1_000, output: 10 } },
    ])
    ask("How many?")

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0]).toMatchObject({ status: "done", content: "13.", inputTokens: 2_000, outputTokens: 50 })
  })
})

describe("text taken back mid-stream", () => {
  /** What a viewer ends up with from the deltas alone, in seq order: appending, or swapping in on replace */
  function viewerText(messageId: string) {
    let text = ""
    for (const delta of radio.of("message.delta").filter((d) => d.messageId === messageId)) text = delta.replace ? delta.text : text + delta.text
    return text
  }

  it("replaces a declined partial for viewers too, not just in the done event", async () => {
    claude = fakeClaude([{ text: "Sure, here is how to do that in detail", stop: "refusal", refusalCategory: "cyber" }], undefined, { chunkSize: 4, chunkDelayMs: 60 })
    ask("Something odd")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.content).toMatch(/^I can't help with that one/)
    expect(radio.of("message.delta").some((d) => d.replace)).toBe(true)
    expect(viewerText(reply.id)).toBe(reply.content)
  })

  it("drops the garbled call's text for viewers before the re-issued call streams its own", async () => {
    const lookup: JackTool<{ what: string }> = {
      name: "lookup",
      description: "Looks something up.",
      input: z.object({ what: z.string() }),
      run: async ({ what }) => ({ forModel: `${what}: 13`, label: `Looked up ${what}` }),
    }
    deps.tools = [lookup]
    claude = fakeClaude(
      [
        { text: "Let me look that up", tools: [{ id: "garbled", name: "lookup", input: { what: "x" } }], error: new Error("Unable to parse tool parameter JSON") },
        { text: "Let me look that up.", tools: [{ id: "ok", name: "lookup", input: { what: "events" } }] },
        { text: "There are 13." },
      ],
      undefined,
      { chunkSize: 4, chunkDelayMs: 60 }
    )
    ask("How many events?")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.content).toBe("Let me look that up.\n\nThere are 13.")
    expect(viewerText(reply.id)).toBe(reply.content) // never "Let me look that upLet me look that up."
    const garbled = parseToolParts(reply.toolCalls).find((p) => p.id === "garbled")
    expect(garbled).toMatchObject({ status: "error", at: 0 })
  })
})

describe("run deadline", () => {
  it("doesn't start another answer without enough time left: it lets go and leaves the messages waiting", async () => {
    deps.timing = { runDeadlineMs: 10_000, minAnswerMs: 6_000, replyDeadlineMs: 9_000 }
    // About 6 s per answer: 60 pieces 100 ms apart
    claude = fakeClaude(() => ({ text: "x".repeat(120) }), undefined, { chunkSize: 2, chunkDelayMs: 100 })
    ask("First question")
    let queued = false
    db.state.hook = (op) => {
      if (!queued && op === "jackMessage.update" && replies().length === 1) {
        queued = true
        ask("A follow-up", "officer-dylan")
      }
    }

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(1)
    expect(replies()[0].status).toBe("done")
    expect(unanswered().map((m) => m.content)).toEqual(["A follow-up"])
    expect(db.room(room.id).runId).toBeNull() // let go, so a post or "continue" can start a fresh run
  })

  it("cancels an answer still going at its deadline, and ends it with a message", async () => {
    deps.timing = { runDeadlineMs: 100_000, minAnswerMs: 1_000, replyDeadlineMs: 2_000 }
    claude = fakeClaude([{ text: "y".repeat(400) }], undefined, { chunkSize: 2, chunkDelayMs: 100 })
    ask("A slow one")

    await onFakeTimers(() => runRoom(room.id, deps))

    const [reply] = replies()
    expect(reply.status).toBe("error")
    expect(reply.content).toMatch(/stopped before it finished/)
    expect(reply.content.length).toBeLessThan(400)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("stops at the run's deadline even when the answer's own cap is later, sending no deltas after it", async () => {
    deps.timing = { runDeadlineMs: 3_000, minAnswerMs: 1_000, replyDeadlineMs: 60_000 }
    claude = fakeClaude([{ text: "z".repeat(400) }], undefined, { chunkSize: 2, chunkDelayMs: 100 })
    const sentAt: { type: string; at: number }[] = []
    const record = deps.broadcast
    deps.broadcast = async (roomId, event) => {
      sentAt.push({ type: event.type, at: Date.now() })
      await record(roomId, event)
    }
    ask("Another slow one")
    const deadlineAt = Date.now() + 3_000

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()[0]).toMatchObject({ status: "error" })
    expect(replies()[0].content).toMatch(/stopped before it finished/)
    // Past the deadline only the done event goes out; it carries the whole text
    expect(sentAt.filter((s) => s.at >= deadlineAt).map((s) => s.type)).toEqual(["message.done"])
    expect(radio.of("message.done")[0].message.content).toBe(replies()[0].content)
  })

  it("counts the run's time from the request's start, not from when it got the lock", async () => {
    ask("Posted a while ago")

    // The request started 200 s ago: 80 s of the 280 s are left, less than an answer needs
    await onFakeTimers(() => runRoom(room.id, deps, { startedAt: Date.now() - 200_000 }))

    expect(replies()).toHaveLength(0)
    expect(unanswered()).toHaveLength(1)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("tells an answer to wrap up a minute before it would be cancelled", async () => {
    // 200 s for the answer: told to wrap up at 140 s, sooner than the usual 150 s
    deps.timing = { runDeadlineMs: 280_000, minAnswerMs: 150_000, replyDeadlineMs: 200_000 }
    const seen: number[] = []
    const lookup: JackTool<{ what: string }> = {
      name: "lookup",
      description: "Looks something up.",
      input: z.object({ what: z.string() }),
      run: async ({ what }) => {
        await new Promise((resolve) => setTimeout(resolve, 70_000))
        seen.push(Date.now())
        return { forModel: `${what}: 13`, label: `Looked up ${what}` }
      },
    }
    deps.tools = [lookup]
    deps.limits = { toolTimeoutMs: 200_000 }
    claude = fakeClaude([
      { tools: [{ name: "lookup", input: { what: "a" } }] },
      { tools: [{ name: "lookup", input: { what: "b" } }] },
      { text: "Done." },
    ])
    ask("Two slow lookups")

    await onFakeTimers(() => runRoom(room.id, deps))

    // 140 s in after two lookups: the third call goes out with tools off
    expect(seen).toHaveLength(2)
    expect(claude.calls[2].tool_choice).toEqual({ type: "none" })
    expect(replies()[0]).toMatchObject({ status: "done", content: "Done." })
  })
})

describe("resumeRoom", () => {
  it("answers messages a run left waiting, and does nothing for a live run", async () => {
    const { resumeRoom } = await import("./rooms")
    ask("Left waiting")
    db.room(room.id).runId = "live-run"
    db.room(room.id).runStartedAt = new Date()

    expect(await onFakeTimers(() => resumeRoom(room.id, { replyDeps: deps }))).toBe("busy")
    expect(replies()).toHaveLength(0)

    db.room(room.id).runId = null
    db.room(room.id).runStartedAt = null
    expect(await onFakeTimers(() => resumeRoom(room.id, { replyDeps: deps }))).toBe("started")
    expect(replies()).toHaveLength(1)
    expect(unanswered()).toHaveLength(0)
  })

  it("takes over a dead run once its lock is stale, closing the half-written reply", async () => {
    const { resumeRoom } = await import("./rooms")
    const stuck = db.addMessage({ roomId: room.id, persona: "jack", status: "streaming", content: "Half", streamSeq: 2 })
    ask("Waiting behind it")
    db.room(room.id).runId = "dead-run"
    db.room(room.id).runStartedAt = new Date(Date.now() - ROOM_LOCK_STALE_MS - MINUTE)

    expect(await onFakeTimers(() => resumeRoom(room.id, { replyDeps: deps }))).toBe("started")

    expect(db.state.messages.find((m) => m.id === stuck.id)?.status).toBe("error")
    expect(unanswered()).toHaveLength(0)
  })

  it("is false for a room that doesn't exist", async () => {
    const { resumeRoom } = await import("./rooms")
    expect(await resumeRoom("room-missing", { replyDeps: deps })).toBeNull()
  })
})

describe("deck jobs that hit a reply's limits", () => {
  const deckWrite: JackTool<Record<string, never>> = {
    name: "deck_write",
    description: "Writes slides.",
    input: z.object({}),
    design: true,
    run: async () => ({ forModel: "Saved.", label: "Wrote slides" }),
  }
  /** Every reply calls deck_write once, is told to wrap up (one design tool call allowed), then hands off */
  const handOffClaude = () =>
    fakeClaude((_params: BetaMessageStreamParams, call: number): FakeTurn =>
      call % 2 === 0 ? { tools: [{ name: "deck_write", input: {} }] } : { text: "Slides 1-2 are done; 3-4 are left." }
    )

  it("leave a note that the run answers, as the officer who asked, at most three times in a row", async () => {
    claude = handOffClaude()
    ask("Make a 4-slide deck for GM 2")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite], limits: { maxDesignToolCalls: 1 } }))

    const notes = db.state.messages.filter((m) => m.kind === "system" && m.continues)
    expect(notes).toHaveLength(3)
    expect(notes.map((n) => n.content)).toEqual(
      [1, 2, 3].map((n) => `Jack hit this reply's limits partway through the deck and is picking up where he left off (automatic, ${n} of 3). Changes from the last reply may have been saved even where a tool shows as failed, so check the deck with deck_view first`)
    )
    expect(notes.every((n) => n.authorUserId === "officer-gray" && n.answeredById !== null)).toBe(true)
    expect(replies()).toHaveLength(4)
    // The next reply reads the note in its turn
    expect(lastUserText(claude.calls[2])).toContain("(Room note: Jack hit this reply's limits partway through the deck")
    expect(radio.of("message.created").filter((e) => e.message.continues)).toHaveLength(3)
  })

  it("start counting again after an officer posts", async () => {
    claude = handOffClaude()
    ask("Make a 4-slide deck for GM 2")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite], limits: { maxDesignToolCalls: 1 } }))
    ask("Keep going")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite], limits: { maxDesignToolCalls: 1 } }))
    expect(db.state.messages.filter((m) => m.kind === "system" && m.continues)).toHaveLength(6)
  })

  it("tell tools a reply that answers a note isn't only an officer's, so it can't save knowledge", async () => {
    const seen: { fromOfficer: boolean | undefined; same: boolean }[] = []
    let first: unknown = null
    const recorder: JackTool<Record<string, never>> = {
      name: "recorder",
      description: "Records what the reply answers.",
      input: z.object({}),
      run: async (_input, ctx) => {
        first ??= ctx.reply
        seen.push({ fromOfficer: ctx.reply?.fromOfficer, same: ctx.reply === first })
        return { forModel: "ok", label: "Recorded" }
      },
    }
    claude = fakeClaude((_params: BetaMessageStreamParams, call: number): FakeTurn =>
      call === 0 ? { tools: [{ name: "deck_write", input: {} }] } : call === 1 ? { text: "Slides 1-2 are done." } : call === 2 ? { tools: [{ name: "recorder", input: {} }, { name: "recorder", input: {} }] } : { text: "Done." }
    )
    ask("Make a 4-slide deck for GM 2")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite, recorder], limits: { maxDesignToolCalls: 1 } }))
    // The second reply answered the continue note: both calls in it saw the same reply state, not an officer's
    expect(seen).toEqual([
      { fromOfficer: false, same: true },
      { fromOfficer: false, same: true },
    ])

    seen.length = 0
    first = null
    claude = fakeClaude([{ tools: [{ name: "recorder", input: {} }] }, { text: "Noted." }])
    ask("Remember that dues are $0 this semester")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [recorder] }))
    expect(seen).toEqual([{ fromOfficer: true, same: true }])
  })

  it("leave a note when a deck reply is cut off at its time limit, not only when it wraps up", async () => {
    deps.timing = { runDeadlineMs: 100_000, minAnswerMs: 1_000, replyDeadlineMs: 2_000 }
    // The deck reply writes slides, then spends too long on its next call and is cancelled; the reply that
    // answers the note is slow too, but never touches a deck, so it leaves no note of its own
    claude = fakeClaude(
      (_params: BetaMessageStreamParams, call: number): FakeTurn => (call === 0 ? { tools: [{ name: "deck_write", input: {} }] } : { text: "y".repeat(400) }),
      undefined,
      { chunkSize: 2, chunkDelayMs: 100 }
    )
    ask("Make a 6-slide deck for GM 2")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite] }))

    expect(replies().map((r) => r.status)).toEqual(["error", "error"])
    const notes = db.state.messages.filter((m) => m.kind === "system" && m.continues)
    expect(notes).toHaveLength(1)
    expect(notes[0].answeredById).toBe(replies()[1].id)
  })

  it("don't leave a note when the deck reply finishes on its own, or a reply never touched a deck", async () => {
    claude = fakeClaude([{ tools: [{ name: "deck_write", input: {} }] }, { text: "All four slides are done." }, { text: "There are 13 members." }])
    ask("Make a 4-slide deck for GM 2")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite] }))
    ask("How many members?")
    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite] }))
    expect(db.state.messages.some((m) => m.continues)).toBe(false)
  })
})

describe("mention mode (design §10)", () => {
  /** An officer message posted in a mention-mode room that didn't mention Jack */
  const aside = (content: string, userId = "officer-gray") => db.addMessage({ roomId: room.id, authorUserId: userId, content, expectsAnswer: false })
  const post = async (content: string, userId = "officer-gray") => {
    const { postOfficerMessage } = await import("./rooms")
    return onFakeTimers(() => postOfficerMessage(room.id, userId, content, { replyDeps: deps }))
  }

  beforeEach(() => {
    db.room(room.id).answerMode = "mention"
  })

  it("starts no run for a message that doesn't mention Jack: it waits for no answer", async () => {
    const message = await post("Should GM 2 move to Thursday?")

    expect(message).toMatchObject({ expectsAnswer: false, answered: false })
    expect(db.state.messages.find((m) => m.id === message!.id)?.expectsAnswer).toBe(false)
    expect(radio.of("message.created").map((e) => e.message.id)).toEqual([message!.id])
    expect(claude.calls).toHaveLength(0)
    // Nothing waits, so a run another post (or "continue") starts answers nothing
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(replies()).toHaveLength(0)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("answers a mention, with what officers said since the last reply as context, marked as not addressed to Jack", async () => {
    const first = await post("Should GM 2 move to Thursday?")
    const second = await post("Thursday works for me", "officer-dylan")
    const mention = await post("@jack how many people registered for GM 2?", "officer-dylan")

    expect(mention).not.toHaveProperty("expectsAnswer")
    expect(replies()).toHaveLength(1)
    const [reply] = replies()
    expect([first, second, mention].map((m) => db.state.messages.find((x) => x.id === m!.id)?.answeredById)).toEqual([reply.id, reply.id, reply.id])
    expect(radio.of("message.created").find((e) => e.message.id === reply.id)?.answers?.sort()).toEqual([first!.id, second!.id, mention!.id].sort())
    // One turn: the mention, and the conversation it came out of
    expect(claude.calls[0].messages).toHaveLength(1)
    const turn = lastUserText(claude.calls[0])
    expect(turn).toContain("Gray: (not addressed to you) Should GM 2 move to Thursday?\nDylan: (not addressed to you) Thursday works for me\nDylan: @jack how many people registered for GM 2?")
    // Tools run as the officer who mentioned Jack
    expect(reply.content).toContain("Dylan: @jack how many")
  })

  it("leaves what's said after the mention for the next mention's reply", async () => {
    const before = aside("Venue is booked")
    const mention = ask("@Jack when is GM 2?")
    const after = aside("Thanks, I'll post it", "officer-dylan")

    await onFakeTimers(() => runRoom(room.id, deps))
    const [reply] = replies()
    expect([before, mention, after].map((m) => m.answeredById)).toEqual([reply.id, reply.id, null])

    const next = ask("@jack and GM 3?")
    await onFakeTimers(() => runRoom(room.id, deps))
    const second = replies()[1]
    expect([after, next].map((m) => m.answeredById)).toEqual([second.id, second.id])
    const turn = lastUserText(claude.calls[1])
    expect(turn).toContain("Dylan: (not addressed to you) Thanks, I'll post it\nGray: @jack and GM 3?")
    expect(turn).not.toContain("Venue is booked")
    // The earlier aside stays in the earlier turn of the history
    expect(claude.calls[1].messages[0].content).toContain("Gray: (not addressed to you) Venue is booked")
  })

  it("mentions the persona answering the room too, as a word of its own", async () => {
    db.room(room.id).persona = "lift"
    expect(await post("@Lift can you dig into this?")).not.toHaveProperty("expectsAnswer")
    expect(await post("@Stand are you there?")).toMatchObject({ expectsAnswer: false })
    expect(await post("mail gray@jack.example about it")).toMatchObject({ expectsAnswer: false })
    expect(await post("@JACK too")).not.toHaveProperty("expectsAnswer")
  })

  it("answers every message again once the room is set back, the old asides as context", async () => {
    const old = aside("Thinking out loud")
    db.room(room.id).answerMode = "always"
    const message = await post("How many members are there?")

    expect(message).not.toHaveProperty("expectsAnswer")
    const [reply] = replies()
    expect([old.answeredById, db.state.messages.find((m) => m.id === message!.id)?.answeredById]).toEqual([reply.id, reply.id])
  })

  it("keeps asides out of a scheduled note's reply and a continue note's reply", async () => {
    const waiting = aside("Side chat")
    scheduledNote("Recurring question 'Weekly signups' (set up by Gray): How many signups this week?")
    db.addMessage({ roomId: room.id, kind: "system", continues: true, authorUserId: "officer-gray", content: "Keep going on the deck" })

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(2)
    expect(waiting.answeredById).toBeNull()
    expect(claude.calls.map(lastUserText).join("\n")).not.toContain("Side chat")
  })
})

describe("archived rooms (design §10)", () => {
  it("start no answer: the run finds nothing waiting and lets go of the lock", async () => {
    const question = ask("Still there?")
    db.room(room.id).archivedAt = new Date()

    await onFakeTimers(() => runRoom(room.id, deps))

    expect(replies()).toHaveLength(0)
    expect(question.answeredById).toBeNull()
    expect(claude.calls).toHaveLength(0)
    expect(db.room(room.id).runId).toBeNull()
  })

  it("let the answer going on finish, then start no other, when the room is archived mid-run", async () => {
    const archiver: JackTool<Record<string, never>> = {
      name: "archiver",
      description: "Archives the room while the reply runs, as an officer would from the menu.",
      input: z.object({}),
      run: async () => {
        db.room(room.id).archivedAt = new Date()
        ask("Posted just before it was archived", "officer-dylan")
        return { forModel: "ok", label: "Done" }
      },
    }
    claude = fakeClaude([{ tools: [{ name: "archiver", input: {} }] }, { text: "Here you go." }])
    ask("First question")

    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [archiver] }))

    expect(replies().map((r) => r.status)).toEqual(["done"])
    expect(unanswered().map((m) => m.content)).toEqual(["Posted just before it was archived"])
    expect(db.room(room.id).runId).toBeNull()
  })

  it("get no continue note when a deck reply stops at its limits after the room was archived", async () => {
    const deckWrite: JackTool<Record<string, never>> = {
      name: "deck_write",
      description: "Writes slides.",
      input: z.object({}),
      design: true,
      run: async () => {
        db.room(room.id).archivedAt = new Date()
        return { forModel: "Saved.", label: "Wrote slides" }
      },
    }
    claude = fakeClaude([{ tools: [{ name: "deck_write", input: {} }] }, { text: "Slides 1-2 are done; 3-4 are left." }])
    ask("Make a 4-slide deck for GM 2")

    await onFakeTimers(() => runRoom(room.id, { ...deps, tools: [deckWrite], limits: { maxDesignToolCalls: 1 } }))

    expect(replies()).toHaveLength(1)
    expect(db.state.messages.some((m) => m.continues)).toBe(false)
  })

  it("take no posts and no continue", async () => {
    const { postOfficerMessage, resumeRoom } = await import("./rooms")
    db.room(room.id).archivedAt = new Date()
    expect(await postOfficerMessage(room.id, "officer-gray", "Hello?", { replyDeps: deps })).toBeNull()
    expect(await resumeRoom(room.id, { replyDeps: deps })).toBeNull()
    expect(db.state.messages).toHaveLength(0)
  })
})
