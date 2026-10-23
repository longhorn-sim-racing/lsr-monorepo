import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { fakeClaude, type FakeTurn } from "./fake-claude"
import type { FakeJackDb } from "./jack-test-db"

vi.mock("@/server/db", async () => {
  const { createFakeJackDb } = await import("./jack-test-db")
  return { prisma: createFakeJackDb() }
})

import { prisma } from "@/server/db"
import { runRoom, type ReplyLoopDeps } from "./reply-loop"

/**
 * Replies to scheduled notes through the real reply loop (design §11.1): the history a recurring
 * question's answer gets, and who writes it.
 */

const db = prisma as unknown as FakeJackDb

let room: ReturnType<FakeJackDb["addRoom"]>
let claude: ReturnType<typeof fakeClaude>
let deps: ReplyLoopDeps

/** The whole history each call sent, as text */
const sent = (call: BetaMessageStreamParams) => call.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n")

function note(content: string, jobKey: string | null, answeredById: string | null = null) {
  return db.addMessage({ roomId: room.id, kind: "system", scheduled: true, authorUserId: "officer-gray", content, jobKey, answeredById })
}

async function onFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  const pending = work()
  await vi.runAllTimersAsync()
  return pending
}

beforeEach(() => {
  vi.useFakeTimers()
  db.reset()
  db.state.users.set("officer-gray", "Gray")
  db.state.users.set("officer-dylan", "Dylan")
  room = db.addRoom({ title: "Signups", persona: "lift" })
  claude = fakeClaude((): FakeTurn => ({ text: "12 people signed up last week." }))
  deps = { broadcast: vi.fn(async () => {}), getClient: () => claude.client, tools: [], budget: async () => ({ month: "October", spentUsd: 1, budgetUsd: 50 }) }
  vi.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a reply to a scheduled note", () => {
  it("sees only the question and its job's last answer: not the officers' conversation, not other jobs' notes", async () => {
    // Last week's run and its answer
    const lastWeek = db.addMessage({ roomId: room.id, kind: "assistant", persona: "jack", content: "9 people signed up last week.", model: "claude-sonnet-5-5" })
    note("Recurring question “Weekly signups” (set up by Gray): How many people signed up last week?", "recurring:q-1", lastWeek.id)
    // Officers talking in the room since, and another question's run
    const chat = db.addMessage({ roomId: room.id, authorUserId: "officer-dylan", content: "Private: our sponsor pitch to Apex is Friday" })
    db.addMessage({ roomId: room.id, kind: "assistant", persona: "lift", content: "Good luck with Apex.", model: "claude-opus-5-5" })
    chat.answeredById = db.state.messages.at(-1)!.id
    const otherAnswer = db.addMessage({ roomId: room.id, kind: "assistant", persona: "jack", content: "Two drafts are waiting.", model: "claude-sonnet-5-5" })
    note("Recurring question “Drafts” (set up by Gray): Any draft events?", "recurring:q-2", otherAnswer.id)
    db.state.recurring.set("q-1", { persona: "jack" })
    // This week's
    note("Recurring question “Weekly signups” (set up by Gray): How many people signed up last week?", "recurring:q-1")

    await onFakeTimers(() => runRoom(room.id, deps))

    const history = sent(claude.calls[0])
    expect(history).toContain("9 people signed up last week.")
    expect(history.match(/How many people signed up last week\?/g)).toHaveLength(2)
    expect(history).not.toMatch(/Apex|Good luck|Drafts|Two drafts/)
  })

  it("is written by its question's persona, Stand here, whatever the room is set to", async () => {
    db.state.recurring.set("q-1", { persona: "stand" })
    note("Recurring question “Weekly signups” (set up by Gray): How many?", "recurring:q-1")
    await onFakeTimers(() => runRoom(room.id, deps))
    const reply = db.state.messages.find((m) => m.kind === "assistant")!
    expect(reply.persona).toBe("stand")
    expect(claude.calls[0].model).toBe("claude-haiku-5-5")
  })

  it("is never Lift: the digest's summary, and a question that's gone, are Jack's", async () => {
    note("Weekly digest for Mon, Oct 26 (set up by Gray): 3 things need attention → /admin", "digest.weekly")
    note("Recurring question “Gone” (set up by Gray): Anything?", "recurring:deleted")
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(db.state.messages.filter((m) => m.kind === "assistant").map((m) => m.persona)).toEqual(["jack", "jack"])
    // Each answered alone, the digest's history holding only itself
    expect(sent(claude.calls[0])).not.toContain("Gone")
  })

  it("still answers a note posted without a job key, from the note alone", async () => {
    db.addMessage({ roomId: room.id, authorUserId: "officer-dylan", content: "Earlier chat" })
    db.state.messages.at(-1)!.answeredById = "elsewhere"
    note("Recurring question “Old” (set up by Gray): How many?", null)
    await onFakeTimers(() => runRoom(room.id, deps))
    expect(sent(claude.calls[0])).not.toContain("Earlier chat")
    expect(sent(claude.calls[0])).toContain("How many?")
  })
})
