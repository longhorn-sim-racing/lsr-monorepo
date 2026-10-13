import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JackDeltaEvent, JackDoneEvent, JackRoomEvent } from "@/lib/jack/types"
import type { FakeJackDb } from "./jack-test-db"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})

import { prisma } from "@/server/db"
import { placeholderReply, runRoom, type ReplyLoopDeps } from "./reply-loop"
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

/** Runs the loop on fake timers, so the placeholder's pacing and the 150 ms batching happen instantly */
async function onFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  const pending = work()
  await vi.runAllTimersAsync()
  return pending
}

let room: ReturnType<FakeJackDb["addRoom"]>
let radio: ReturnType<typeof fakeBroadcaster>
let deps: ReplyLoopDeps

function ask(content: string, userId = "officer-gray") {
  return db.addMessage({ roomId: room.id, authorUserId: userId, content })
}

const replies = () => db.state.messages.filter((m) => m.persona !== null)
const unanswered = () => db.state.messages.filter((m) => m.persona === null && m.answeredById === null)
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
  room = db.addRoom()
  radio = fakeBroadcaster()
  deps = { broadcast: radio.broadcast, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  vi.spyOn(console, "error").mockImplementation(() => {})
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
    const expected = placeholderReply([{ content: question.content, author: { displayName: "Gray" } }])
    expect(expected).toContain("Gray: How many LSC applications are there?")
    expect(reply).toMatchObject({ persona: "jack", status: "done", content: expected })
    expect(db.state.messages.find((m) => m.id === question.id)?.answeredById).toBe(reply.id)

    const types = radio.sent.map((s) => s.event.type)
    expect(types[0]).toBe("message.created")
    expect(types.at(-1)).toBe("message.done")
    const deltas = radio.of("message.delta")
    expect(deltas.length).toBeGreaterThan(5) // it streams, in ~150 ms batches over ~3 s
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
    const answeredBy = db.state.messages.filter((m) => m.persona === null).map((m) => m.answeredById)
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
})
