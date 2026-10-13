import { describe, expect, it } from "vitest"
import { initRoomState, roomReducer, type RoomAction, type RoomState } from "./room-state"
import type { JackMessageView, JackRoomView } from "./types"

const officerMessage = (id: string, createdAt: string, content = "How many LSC applications?"): JackMessageView => ({
  id,
  roomId: "room-1",
  author: { kind: "user", userId: "officer-1", displayName: "Gray" },
  content,
  tools: [],
  status: "done",
  streamSeq: 0,
  createdAt,
})

const reply = (fields: Partial<JackMessageView> = {}): JackMessageView => ({
  id: "reply-1",
  roomId: "room-1",
  author: { kind: "assistant", persona: "jack" },
  content: "",
  tools: [],
  status: "streaming",
  streamSeq: 0,
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
const created = (message: JackMessageView): RoomAction => ({ type: "message.created", message })
const done = (message: JackMessageView): RoomAction => ({ type: "message.done", message })
const snapshot = (messages: JackMessageView[], snapshotRoom = room()): RoomAction => ({ type: "snapshot", room: snapshotRoom, messages })

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
})
