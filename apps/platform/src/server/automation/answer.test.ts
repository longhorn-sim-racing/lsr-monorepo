import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackMessage: { findUnique: vi.fn() }, jackRoom: { findUnique: vi.fn() }, scheduledJob: { updateMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/reply-loop", () => ({ runRoom: vi.fn(), defaultReplyDeps: {} }))

import { answerScheduledNote, retryJobAt } from "./answer"

const note = { id: "note-1", roomId: "room-1" }
const free = { runId: null, runStartedAt: null }
const held = () => ({ runId: "run-other", runStartedAt: new Date() })
const reply = { id: "reply-1", status: "done", costUsd: "0.042100" }

beforeEach(() => {
  db.jackMessage.findUnique.mockResolvedValue({ answeredBy: null })
  db.jackRoom.findUnique.mockResolvedValue(free)
  db.scheduledJob.updateMany.mockResolvedValue({ count: 1 })
})

describe("answering a scheduled note", () => {
  it("runs the room, then reports the reply that answered it", async () => {
    const run = vi.fn(async () => {
      db.jackMessage.findUnique.mockResolvedValue({ answeredBy: reply })
    })
    expect(await answerScheduledNote(note, 1_000, run)).toEqual({ answer: { id: "reply-1", status: "done", costUsd: 0.0421 } })
    expect(run).toHaveBeenCalledWith("room-1", { startedAt: 1_000 })
  })

  it("leaves a busy room to the run that holds it, and says it's busy", async () => {
    db.jackRoom.findUnique.mockResolvedValue(held())
    const run = vi.fn()
    expect(await answerScheduledNote(note, 1_000, run)).toEqual({ answer: null, busy: true })
    expect(run).not.toHaveBeenCalled()
  })

  it("doesn't run the room again for a note that already has its answer (another run took it)", async () => {
    db.jackMessage.findUnique.mockResolvedValue({ answeredBy: { ...reply, status: "streaming", costUsd: null } })
    const run = vi.fn()
    expect(await answerScheduledNote(note, 1_000, run)).toEqual({ answer: { id: "reply-1", status: "streaming", costUsd: null } })
    expect(run).not.toHaveBeenCalled()
  })

  it("says the room is busy when a run took it while this one was letting go", async () => {
    db.jackRoom.findUnique.mockResolvedValueOnce(free).mockResolvedValueOnce(held())
    const run = vi.fn()
    expect(await answerScheduledNote(note, 1_000, run)).toEqual({ answer: null, busy: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("gives up quietly on a room that's gone", async () => {
    db.jackRoom.findUnique.mockResolvedValue(null)
    expect(await answerScheduledNote(note, 1_000, vi.fn())).toEqual({ answer: null, busy: false })
  })
})

describe("trying again later", () => {
  it("moves the next run up only while the job is on and isn't due sooner", async () => {
    const at = new Date("2026-10-26T14:03:00Z")
    expect(await retryJobAt("job-1", at)).toBe(true)
    expect(db.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: "job-1", enabled: true, nextRunAt: { gt: at } }, data: { nextRunAt: at } })
    db.scheduledJob.updateMany.mockResolvedValue({ count: 0 })
    expect(await retryJobAt("job-1", at)).toBe(false)
  })
})
