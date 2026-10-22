import { describe, expect, it } from "vitest"
import type { JackToolPart } from "./parts"
import { initRoomState, roomReducer, stallCandidate, stallQuietMs, STALL_QUIET_MS, STUCK_QUIET_MS, type RoomAction, type RoomState } from "./room-state"
import { ROOM_LOCK_STALE_MS } from "./timing"
import type { JackMessageView, JackRoomView } from "./types"

const officerMessage = (id: string, createdAt: string, content = "How many LSC applications?", answered = true): JackMessageView => ({
  id,
  roomId: "room-1",
  author: { kind: "user", userId: "officer-1", displayName: "Gray", avatarUrl: null },
  content,
  tools: [],
  status: "done",
  streamSeq: 0,
  answered,
  createdAt,
})
const waitingMessage = (id: string, createdAt: string) => officerMessage(id, createdAt, "Still waiting?", false)

const reply = (fields: Partial<JackMessageView> = {}): JackMessageView => ({
  id: "reply-1",
  roomId: "room-1",
  author: { kind: "assistant", persona: "jack" },
  content: "",
  tools: [],
  status: "streaming",
  streamSeq: 0,
  answered: true,
  createdAt: "2026-10-12T20:00:01.000Z",
  ...fields,
})

const room = (fields: Partial<JackRoomView> = {}): JackRoomView => ({
  id: "room-1",
  title: null,
  persona: "jack",
  updatedAt: "2026-10-12T20:00:00.000Z",
  ...fields,
})
const start = (messages: JackMessageView[] = []) => initRoomState({ room: room(), messages })

const delta = (seq: number, text: string, messageId = "reply-1"): RoomAction => ({ type: "message.delta", messageId, seq, text })
const replaceWith = (seq: number, text: string, messageId = "reply-1"): RoomAction => ({ type: "message.delta", messageId, seq, text, replace: true })
const trimmedDone = (message: JackMessageView): RoomAction => ({ type: "message.done", message, trimmed: true })
const created = (message: JackMessageView): RoomAction => ({ type: "message.created", message })
const done = (message: JackMessageView): RoomAction => ({ type: "message.done", message })
const snapshot = (messages: JackMessageView[], snapshotRoom = room()): RoomAction => ({ type: "snapshot", room: snapshotRoom, messages })

const part = (id: string, fields: Partial<JackToolPart> = {}): JackToolPart => ({
  id,
  name: "run_sql",
  label: "Using run_sql",
  status: "running",
  at: 0,
  input: null,
  displays: [],
  ...fields,
})
const tool = (p: JackToolPart, messageId = "reply-1"): RoomAction => ({ type: "message.tool", messageId, part: p })

const run = (state: RoomState, ...actions: RoomAction[]) => actions.reduce(roomReducer, state)
const replyOf = (state: RoomState, id = "reply-1") => state.messages.find((m) => m.id === id)

describe("roomReducer", () => {
  it("streams deltas in order into the reply", () => {
    const state = run(start(), created(reply()), delta(1, "Jack "), delta(2, "here"), delta(3, "."))

    expect(replyOf(state)).toMatchObject({ content: "Jack here.", streamSeq: 3, status: "streaming" })
    expect(state.needsResync).toBe(false)
  })

  it("keeps messages in time order however they arrive", () => {
    const later = officerMessage("m2", "2026-10-12T20:00:05.000Z", "second")
    const earlier = officerMessage("m1", "2026-10-12T20:00:00.000Z", "first")
    const state = run(start([later]), created(earlier), created(reply()))

    expect(state.messages.map((m) => m.id)).toEqual(["m1", "reply-1", "m2"])
  })

  it("ignores repeated created events and repeated deltas", () => {
    const state = run(
      start(),
      created(reply()),
      delta(1, "a"),
      created(reply()),
      delta(1, "a"),
      delta(2, "b"),
      delta(2, "b")
    )

    expect(state.messages).toHaveLength(1)
    expect(replyOf(state)).toMatchObject({ content: "ab", streamSeq: 2 })
    expect(state.needsResync).toBe(false)
  })

  it("holds a delta that skips ahead, asks for a resync, and fills in when the missing one arrives", () => {
    const gapped = run(start(), created(reply()), delta(1, "a"), delta(3, "c"))
    expect(replyOf(gapped)).toMatchObject({ content: "a", streamSeq: 1 })
    expect(gapped.needsResync).toBe(true)

    const filled = run(gapped, delta(2, "b"))
    expect(replyOf(filled)).toMatchObject({ content: "abc", streamSeq: 3 })
    expect(filled.needsResync).toBe(false)
    expect(filled.pending).toEqual({})
  })

  it("closes a gap from a snapshot that covers it", () => {
    const gapped = run(start(), created(reply()), delta(1, "a"), delta(4, "d"), delta(5, "e"))
    const state = run(gapped, snapshot([reply({ content: "abc", streamSeq: 3 })]))

    expect(replyOf(state)).toMatchObject({ content: "abcde", streamSeq: 5 })
    expect(state.needsResync).toBe(false)
    expect(state.resyncAttempts).toBe(0)
  })

  it("keeps asking when the snapshot still trails the gap", () => {
    const gapped = run(start(), created(reply()), delta(1, "a"), delta(4, "d"))
    const state = run(gapped, snapshot([reply({ content: "ab", streamSeq: 2 })]))

    expect(replyOf(state)).toMatchObject({ content: "ab", streamSeq: 2 })
    expect(state.needsResync).toBe(true)
    expect(state.resyncAttempts).toBe(1)
  })

  it("never moves a reply backwards when a snapshot is older than what it has", () => {
    const live = run(start(), created(reply()), delta(1, "a"), delta(2, "b"), delta(3, "c"))
    const state = run(live, snapshot([reply({ content: "a", streamSeq: 1 })]))

    expect(replyOf(state)).toMatchObject({ content: "abc", streamSeq: 3 })
    expect(state.needsResync).toBe(false)
  })

  it("late join: starts from the snapshot and applies only the deltas after it", () => {
    const joined = start([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ content: "Jack he", streamSeq: 7 })])
    const state = run(joined, delta(6, "ck h"), delta(7, "e"), delta(8, "re"), delta(9, "."))

    expect(replyOf(state)).toMatchObject({ content: "Jack here.", streamSeq: 9 })
    expect(state.needsResync).toBe(false)
  })

  it("late join with a gap: holds the newer deltas until a fresher snapshot arrives", () => {
    const joined = start([reply({ content: "ab", streamSeq: 2 })])
    const gapped = run(joined, delta(5, "e"), delta(6, "f"))
    expect(gapped.needsResync).toBe(true)

    const state = run(gapped, snapshot([reply({ content: "abcd", streamSeq: 4 })]))
    expect(replyOf(state)).toMatchObject({ content: "abcdef", streamSeq: 6 })
    expect(state.needsResync).toBe(false)
  })

  it("holds deltas for a message it hasn't seen until its created event or a snapshot brings it", () => {
    const early = run(start(), delta(1, "a"), delta(2, "b"))
    expect(early.messages).toHaveLength(0)
    expect(early.needsResync).toBe(true)

    const state = run(early, created(reply()))
    expect(replyOf(state)).toMatchObject({ content: "ab", streamSeq: 2 })
    expect(state.needsResync).toBe(false)
  })

  it("takes the done event's full text, even after missed deltas", () => {
    const gapped = run(start(), created(reply()), delta(1, "a"), delta(3, "c"))
    const final = reply({ content: "abcd", streamSeq: 4, status: "done" })
    const state = run(gapped, done(final))

    expect(replyOf(state)).toEqual(final)
    expect(state.needsResync).toBe(false)
    expect(state.pending).toEqual({})
  })

  it("ignores deltas and stale snapshots after a reply is done", () => {
    const final = reply({ content: "abc", streamSeq: 3, status: "done" })
    const state = run(start(), done(final), delta(4, "late"), snapshot([reply({ content: "a", streamSeq: 1 })]))

    expect(replyOf(state)).toEqual(final)
    expect(state.needsResync).toBe(false)
  })

  it("shows an errored reply as it ended", () => {
    const failed = reply({ content: "Jack", streamSeq: 1, status: "error" })
    const state = run(start(), created(reply()), delta(1, "Jack"), done(failed))

    expect(replyOf(state)).toMatchObject({ status: "error", content: "Jack" })
  })

  it("keeps messages a snapshot doesn't have yet", () => {
    const mine = officerMessage("m2", "2026-10-12T20:00:09.000Z", "just posted")
    const state = run(start(), created(mine), snapshot([officerMessage("m1", "2026-10-12T20:00:00.000Z")]))

    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("switches the room's persona live, and a stale snapshot doesn't switch it back", () => {
    const switched = room({ persona: "lift", updatedAt: "2026-10-12T20:05:00.000Z" })
    const live = run(start(), { type: "room.updated", room: switched })
    expect(live.room.persona).toBe("lift")

    const stale = run(live, snapshot([], room({ persona: "jack", updatedAt: "2026-10-12T20:04:00.000Z" })))
    expect(stale.room.persona).toBe("lift")

    const fresh = run(stale, snapshot([], room({ persona: "jack", updatedAt: "2026-10-12T20:06:00.000Z" })))
    expect(fresh.room.persona).toBe("jack")
  })

  it("shows system messages like any other", () => {
    const note: JackMessageView = {
      ...officerMessage("s1", "2026-10-12T20:00:03.000Z", "Gray switched this room to Lift"),
      author: { kind: "system" },
    }
    const state = run(start(), created(note), created(note))
    expect(state.messages).toEqual([note])
  })

  describe("tool parts", () => {
    it("adds a part to a streaming reply and updates it in place", () => {
      const state = run(
        start(),
        created(reply()),
        delta(1, "Let me check."),
        tool(part("t1", { at: 13 })),
        tool(part("t1", { at: 13, input: { sql: "select 1" } })),
        tool(part("t1", { at: 13, input: { sql: "select 1" }, status: "done", label: "Ran a query (1 row)" }))
      )

      expect(replyOf(state)?.tools).toEqual([part("t1", { at: 13, input: { sql: "select 1" }, status: "done", label: "Ran a query (1 row)" })])
      expect(replyOf(state)?.content).toBe("Let me check.")
    })

    it("keeps parts in reply order however they arrive", () => {
      const state = run(start(), created(reply()), tool(part("late", { at: 40 })), tool(part("early", { at: 10 })))

      expect(replyOf(state)?.tools.map((p) => p.id)).toEqual(["early", "late"])
    })

    it("never takes a finished part back to running", () => {
      const finished = part("t1", { status: "done", label: "Ran a query" })
      const state = run(start(), created(reply()), tool(finished), tool(part("t1")))

      expect(replyOf(state)?.tools).toEqual([finished])
    })

    it("holds a part for a reply it hasn't seen until the reply arrives", () => {
      const early = run(start(), tool(part("t1")))
      expect(early.messages).toHaveLength(0)
      expect(early.needsResync).toBe(true)

      const state = run(early, created(reply()))
      expect(replyOf(state)?.tools.map((p) => p.id)).toEqual(["t1"])
      expect(state.needsResync).toBe(false)
      expect(state.pendingParts).toEqual({})
    })

    it("a snapshot adds the parts it has and finishes running ones, without dropping live ones", () => {
      const live = run(start(), created(reply()), delta(1, "abc"), tool(part("t1", { at: 3 })), tool(part("t2", { at: 3 })))
      const fromDb = reply({
        content: "abcdef",
        streamSeq: 2,
        tools: [part("t1", { at: 3, status: "done", label: "Ran a query" }), part("t0", { at: 0, status: "done" })],
      })

      const state = run(live, snapshot([fromDb]))

      expect(replyOf(state)?.content).toBe("abcdef")
      expect(replyOf(state)?.tools.map((p) => [p.id, p.status])).toEqual([
        ["t0", "done"],
        ["t1", "done"],
        ["t2", "running"],
      ])
    })

    it("a snapshot that trails the live parts doesn't undo them", () => {
      const live = run(start(), created(reply()), delta(1, "abc"), delta(2, "def"), tool(part("t1", { status: "done", label: "Ran a query" })))
      const state = run(live, snapshot([reply({ content: "abc", streamSeq: 1, tools: [part("t1")] })]))

      expect(replyOf(state)).toMatchObject({ content: "abcdef", streamSeq: 2 })
      expect(replyOf(state)?.tools).toEqual([part("t1", { status: "done", label: "Ran a query" })])
    })

    it("takes the done event's parts as final, and ignores parts after it", () => {
      const final = reply({ content: "abc", streamSeq: 1, status: "done", tools: [part("t1", { status: "done", label: "Ran a query" })] })
      const state = run(start(), created(reply()), tool(part("t1")), tool(part("t9")), done(final), tool(part("t2")))

      expect(replyOf(state)).toEqual(final)
      expect(state.pendingParts).toEqual({})
    })
  })

  describe("text taken back mid-stream", () => {
    it("swaps in a replacing delta's text instead of appending it", () => {
      const state = run(start(), created(reply()), delta(1, "Sure, here is"), delta(2, " how"), replaceWith(3, "I can't help"), delta(4, " with that one."))

      expect(replyOf(state)).toMatchObject({ content: "I can't help with that one.", streamSeq: 4 })
      expect(state.needsResync).toBe(false)
    })

    it("applies a held replacing delta in seq order once the gap fills", () => {
      const gapped = run(start(), created(reply()), delta(1, "Let me"), replaceWith(3, ""), delta(4, "Counting."))
      expect(replyOf(gapped)?.content).toBe("Let me")
      expect(gapped.needsResync).toBe(true)

      const state = run(gapped, delta(2, " look"))
      expect(replyOf(state)).toMatchObject({ content: "Counting.", streamSeq: 4 })
      expect(state.needsResync).toBe(false)
    })

    it("a late joiner's snapshot before the replace still ends right", () => {
      const joined = start([reply({ content: "Sure, here is how", streamSeq: 2 })])
      const state = run(joined, replaceWith(3, "I can't help with that one."))

      expect(replyOf(state)?.content).toBe("I can't help with that one.")
    })
  })

  describe("a trimmed done event", () => {
    const table = { kind: "table" as const, columns: ["n"], rows: [[13]], truncated: false }

    it("keeps the text and displays it has, finishes the reply, and asks for a snapshot", () => {
      const live = run(start(), created(reply()), delta(1, "Here."), tool(part("t1", { status: "done", label: "Ran a query", displays: [table] })))
      const trimmed = reply({ content: "Here.", streamSeq: 1, status: "done", tools: [part("t1", { status: "done", label: "Ran a query" })] })

      const state = run(live, trimmedDone(trimmed))

      expect(replyOf(state)).toMatchObject({ status: "done", content: "Here." })
      expect(replyOf(state)?.tools[0].displays).toEqual([table])
      expect(state.needsResync).toBe(true)
      expect(state.incomplete).toEqual({ "reply-1": true })
    })

    it("keeps the streamed text when the event had to leave the text out too", () => {
      const live = run(start(), created(reply()), delta(1, "A long answer"))
      const state = run(live, trimmedDone(reply({ content: "", tools: [], status: "done", streamSeq: 9 })))

      expect(replyOf(state)).toMatchObject({ status: "done", content: "A long answer" })
      expect(state.needsResync).toBe(true)
    })

    it("takes the snapshot's copy whole, then stops asking", () => {
      const live = run(start(), created(reply()), trimmedDone(reply({ content: "Here.", status: "done", tools: [part("t1", { status: "done" })] })))
      const whole = reply({ content: "Here.", status: "done", tools: [part("t1", { status: "done", displays: [table] })] })

      const state = run(live, snapshot([whole]))

      expect(replyOf(state)).toEqual(whole)
      expect(state.needsResync).toBe(false)
      expect(state.incomplete).toEqual({})
    })

    it("keeps asking while the snapshot still has the reply streaming", () => {
      const live = run(start(), created(reply()), trimmedDone(reply({ content: "Here.", status: "done" })))
      const state = run(live, snapshot([reply({ content: "He", streamSeq: 1 })]))

      expect(replyOf(state)?.status).toBe("done")
      expect(state.needsResync).toBe(true)
      expect(state.resyncAttempts).toBe(1)
    })

    it("is ignored for a reply that's already whole", () => {
      const final = reply({ content: "Here.", status: "done", tools: [part("t1", { status: "done", displays: [table] })] })
      const whole = run(start(), done(final))
      const state = run(whole, trimmedDone(reply({ content: "Here.", status: "done", tools: [part("t1", { status: "done" })] })))

      expect(state).toBe(whole)
    })
  })

  describe("resync_failed", () => {
    it("counts a failed fetch as an attempt, so the page backs off and tries again", () => {
      const gapped = run(start(), created(reply()), delta(1, "a"), delta(3, "c"))
      const failed = run(gapped, { type: "resync_failed" }, { type: "resync_failed" })

      expect(failed.needsResync).toBe(true)
      expect(failed.resyncAttempts).toBe(2)
      expect(replyOf(failed)?.content).toBe("a")
    })

    it("changes nothing when nothing is missing", () => {
      const state = run(start(), created(reply()), delta(1, "a"))
      expect(run(state, { type: "resync_failed" })).toBe(state)
    })
  })
})

describe("stallCandidate", () => {
  const note: JackMessageView = { ...officerMessage("s1", "2026-10-12T20:00:05.000Z", "Gray switched this room to Lift"), author: { kind: "system" } }

  it("is unanswered when an officer message no reply picked up waits and nothing streams", () => {
    expect(stallCandidate([waitingMessage("m1", "2026-10-12T20:00:00.000Z")])).toBe("unanswered")
    const answered = [officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ status: "done" })]
    expect(stallCandidate(answered)).toBeNull()
    expect(stallCandidate([...answered, waitingMessage("m2", "2026-10-12T20:00:09.000Z")])).toBe("unanswered")
    expect(stallCandidate([...answered, waitingMessage("m2", "2026-10-12T20:00:09.000Z"), note])).toBe("unanswered")
  })

  it("goes by answered, not order: a message posted while the reply was set up sorts above it", () => {
    // Posted between the run looking for messages and creating its reply: older than the reply, not in it
    const race = [officerMessage("m1", "2026-10-12T20:00:00.000Z"), waitingMessage("m2", "2026-10-12T20:00:00.500Z"), reply({ status: "done" })]
    expect(stallCandidate(race)).toBe("unanswered")
  })

  it("counts a waiting note that asks Jack to keep going on a deck, until a reply picks it up", () => {
    const keepGoing: JackMessageView = { ...note, id: "s2", continues: true, answered: false }
    expect(stallCandidate([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ status: "done" }), keepGoing])).toBe("unanswered")
    expect(stallCandidate([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ status: "done" }), { ...keepGoing, answered: true }])).toBeNull()
  })

  it("ignores system notes, and answered messages after the last reply", () => {
    expect(stallCandidate([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ status: "done" }), note])).toBeNull()
    expect(stallCandidate([reply({ status: "done" }), officerMessage("m2", "2026-10-12T20:00:09.000Z")])).toBeNull()
    expect(stallCandidate([])).toBeNull()
  })

  it("is stuck while a reply is streaming, which only counts after the room lock would be stale", () => {
    expect(stallCandidate([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply()])).toBe("stuck")
    expect(stallQuietMs("stuck")).toBe(STUCK_QUIET_MS)
    expect(STUCK_QUIET_MS).toBeGreaterThan(ROOM_LOCK_STALE_MS)
    expect(stallQuietMs("unanswered")).toBe(STALL_QUIET_MS)
  })
})

describe("answered officer messages", () => {
  const replyCreated = (answers: string[]): RoomAction => ({ type: "message.created", message: reply(), answers })

  it("marks the messages a new reply answers", () => {
    const state = run(start(), created(waitingMessage("m1", "2026-10-12T20:00:00.000Z")), created(waitingMessage("m2", "2026-10-12T20:00:00.500Z")), replyCreated(["m1"]))

    expect(state.messages.find((m) => m.id === "m1")?.answered).toBe(true)
    expect(state.messages.find((m) => m.id === "m2")?.answered).toBe(false)
    expect(stallCandidate(run(state, done(reply({ status: "done" }))).messages)).toBe("unanswered")
  })

  it("keeps a message answered when an older copy (the poster's own, or a stale snapshot) says it isn't", () => {
    const answered = run(start(), created(waitingMessage("m1", "2026-10-12T20:00:00.000Z")), replyCreated(["m1"]))
    const state = run(answered, created(waitingMessage("m1", "2026-10-12T20:00:00.000Z")), snapshot([waitingMessage("m1", "2026-10-12T20:00:00.000Z")]))

    expect(state.messages.find((m) => m.id === "m1")?.answered).toBe(true)
  })

  it("takes answered from a snapshot when the reply's created event was missed", () => {
    const missed = run(start(), created(waitingMessage("m1", "2026-10-12T20:00:00.000Z")))
    const state = run(missed, snapshot([officerMessage("m1", "2026-10-12T20:00:00.000Z"), reply({ status: "done", content: "Hi" })]))

    expect(state.messages.find((m) => m.id === "m1")?.answered).toBe(true)
  })
})

describe("snapshots and unchanged messages", () => {
  it("keeps each finished message's object when a snapshot has the same copy, so rows don't re-render", () => {
    const table = { kind: "table" as const, columns: ["n"], rows: [[13]], truncated: false }
    const messages = [
      officerMessage("m1", "2026-10-12T20:00:00.000Z"),
      reply({ status: "done", content: "13.", tools: [part("t1", { status: "done", label: "Ran a query", displays: [table] })] }),
    ]
    const before = start(messages)
    // A snapshot builds fresh objects for the same rows
    const after = run(before, snapshot(structuredClone(messages)))

    expect(after.messages).toBe(before.messages)
    expect(after.messages[0]).toBe(before.messages[0])
    expect(after.messages[1]).toBe(before.messages[1])
  })

  it("still takes a snapshot's copy when it says something new", () => {
    const before = start([reply({ status: "done", content: "13." })])
    const after = run(before, snapshot([reply({ status: "error", content: "13." })]))

    expect(after.messages[0]).not.toBe(before.messages[0])
    expect(after.messages[0].status).toBe("error")
  })
})
