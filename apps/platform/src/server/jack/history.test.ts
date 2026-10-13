import { describe, expect, it } from "vitest"
import { buildHistory, formatTurnTime, windowStart, type HistoryRow } from "./history"

let clock = Date.parse("2026-10-13T20:00:00.000Z")
let ids = 0

function row(fields: Partial<HistoryRow> & Pick<HistoryRow, "kind">): HistoryRow {
  clock += 60_000
  return {
    id: `m${String(++ids).padStart(3, "0")}`,
    persona: fields.kind === "assistant" ? "jack" : null,
    content: "",
    toolCalls: null,
    status: "done",
    answeredById: null,
    model: null,
    createdAt: new Date(clock),
    author: null,
    ...fields,
  }
}

const officer = (name: string, content: string, answeredById: string | null = null) =>
  row({ kind: "user", author: { displayName: name }, content, answeredById })

/** A room: each exchange is officer messages and the reply that answered them */
function room(exchanges: { ask: [string, string][]; reply?: Partial<HistoryRow> }[]) {
  const rows: HistoryRow[] = []
  for (const exchange of exchanges) {
    const asks = exchange.ask.map(([name, text]) => officer(name, text))
    rows.push(...asks)
    const reply = row({ kind: "assistant", content: "An answer.", model: "claude-sonnet-5-5", ...exchange.reply })
    rows.push(reply)
    for (const ask of asks) ask.answeredById = reply.id
  }
  return rows
}

describe("buildHistory", () => {
  it("makes one officer turn per reply, every officer named, under a Central Time stamp", () => {
    const rows = room([{ ask: [["Gray", "How many LSC applications?"], ["Dylan", "And paid?"]], reply: { status: "streaming", content: "" } }])
    const replyId = rows.at(-1)!.id

    const history = buildHistory(rows, replyId)

    expect(history).toEqual([{ role: "user", content: `[${formatTurnTime(rows[1].createdAt)}]\nGray: How many LSC applications?\nDylan: And paid?` }])
    expect(formatTurnTime(new Date("2026-10-13T20:05:00.000Z"))).toBe("Tue, Oct 13, 2026, 3:05 PM CT")
  })

  it("sends earlier replies as their text with a note of the tools they used", () => {
    const tools = [
      { id: "t1", name: "run_sql", label: "Ran a query (13 rows)", status: "done", at: 0, input: { sql: "select 1" }, displays: [] },
      { id: "t2", name: "chart", label: "Couldn't draw it", status: "error", at: 5, input: { type: "pie" }, displays: [], error: "Too many slices" },
    ]
    const rows = room([
      { ask: [["Gray", "Applications by school?"]], reply: { content: "Most are from UT.", toolCalls: tools } },
      { ask: [["Gray", "Thanks"]], reply: { status: "streaming", content: "" } },
    ])

    const history = buildHistory(rows, rows.at(-1)!.id)

    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(history[1].content).toBe(
      'Most are from UT.\n\n[Tools used: run_sql {"sql":"select 1"} → Ran a query (13 rows); chart {"type":"pie"} → failed: Too many slices]'
    )
  })

  it("puts a persona switch note in the turn it came before", () => {
    const rows = room([{ ask: [["Gray", "Members?"]], reply: { content: "42." } }])
    rows.push(row({ kind: "system", content: "Gray switched this room to Lift" }))
    const next = room([{ ask: [["Dylan", "Who raced most?"]], reply: { persona: "lift", status: "streaming", content: "" } }])
    rows.push(...next)

    const history = buildHistory(rows, rows.at(-1)!.id)

    expect(history[2].content).toMatch(/^\[.+\]\n\(Room note: Gray switched this room to Lift\)\nDylan: Who raced most\?$/)
  })

  it("groups by the reply that answered each message, not by time", () => {
    // Dylan posted while the first reply was being set up, so it was left for the second reply
    const gray = officer("Gray", "First")
    const dylan = officer("Dylan", "Second")
    const first = row({ kind: "assistant", content: "Answer one.", model: "claude-sonnet-5-5" })
    const second = row({ kind: "assistant", status: "streaming" })
    gray.answeredById = first.id
    dylan.answeredById = second.id

    const history = buildHistory([gray, dylan, first, second], second.id)

    expect(history.map((m) => m.content)).toEqual([expect.stringMatching(/Gray: First$/), "Answer one.", expect.stringMatching(/Dylan: Second$/)])
  })

  it("leaves out unanswered messages, Stand's notes and anything after the reply", () => {
    const rows = room([{ ask: [["Gray", "Q"]], reply: { status: "streaming" } }])
    const replyId = rows.at(-1)!.id
    rows.push(officer("Dylan", "Posted mid-answer"))
    rows.push(row({ kind: "system", content: "Stand named this room “X”", model: "claude-haiku-5-5" }))
    rows.push(row({ kind: "system", content: "Dylan switched this room to Lift" }))

    const history = buildHistory(rows, replyId)

    expect(history).toHaveLength(1)
    expect(history[0].content).toMatch(/Gray: Q$/)
  })

  it("leaves out replies Claude didn't write, so their questions carry over", () => {
    const rows = room([
      { ask: [["Gray", "How many members?"]], reply: { content: "Jack isn't connected yet: an admin needs to add the Anthropic API key.", model: null } },
      { ask: [["Gray", "Now?"]], reply: { status: "streaming" } },
    ])

    const history = buildHistory(rows, rows.at(-1)!.id)

    expect(history).toHaveLength(1)
    expect(history[0].content).toMatch(/Gray: How many members\?\n\n\[.+\]\nGray: Now\?$/)
  })

  it("marks replies that failed", () => {
    const rows = room([
      { ask: [["Gray", "A"]], reply: { status: "error", content: "Half an ans" } },
      { ask: [["Gray", "B"]], reply: { status: "error", content: "" } },
      { ask: [["Gray", "C"]], reply: { status: "streaming" } },
    ])

    const history = buildHistory(rows, rows.at(-1)!.id)

    expect(history[1].content).toBe("Half an ans\n[This reply stopped early.]")
    expect(history[3].content).toBe("[This reply failed before it said anything.]")
  })

  it("merges turns around a reply that said nothing", () => {
    const rows = room([
      { ask: [["Gray", "A"]], reply: { content: "" } },
      { ask: [["Gray", "B"]], reply: { status: "streaming" } },
    ])

    const history = buildHistory(rows, rows.at(-1)!.id)

    expect(history).toHaveLength(1)
    expect(history[0].content).toMatch(/Gray: A\n\n\[.+\]\nGray: B$/)
  })

  it("is the same bytes every time, and the last request is a prefix of the next (so it stays cached)", () => {
    const rows = room(Array.from({ length: 5 }, (_, i) => ({ ask: [["Gray", `Question ${i}`]] as [string, string][], reply: { content: `Answer ${i}` } })))
    const fifth = rows.at(-1)!
    fifth.status = "streaming"
    fifth.content = ""
    const before = buildHistory(rows, fifth.id)
    expect(buildHistory([...rows].reverse(), fifth.id)).toEqual(before)

    fifth.status = "done"
    fifth.content = "Answer 4"
    rows.push(...room([{ ask: [["Dylan", "One more"]], reply: { status: "streaming", content: "" } }]))
    const after = buildHistory(rows, rows.at(-1)!.id)

    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 2)
  })

  it("keeps the last 40 exchanges, moving the start in steps of 10, and says earlier ones are left out", () => {
    const rows = room(Array.from({ length: 45 }, (_, i) => ({ ask: [["Gray", `Q${i}`]] as [string, string][], reply: { content: `A${i}` } })))
    rows.at(-1)!.status = "streaming"

    const history = buildHistory(rows, rows.at(-1)!.id)

    // 45 turns: the first 10 go
    expect(history[0].content).toMatch(/^\(Earlier messages in this room aren't included\.\)\n\[.+\]\nGray: Q10$/)
    expect(history).toHaveLength(35 * 2 - 1)
  })
})

describe("windowStart", () => {
  const limits = { maxTurns: 40, turnStep: 10, maxChars: 1_000 }

  it("starts at 0 until there are more than maxTurns, then jumps in steps", () => {
    expect(windowStart(Array(40).fill(1), limits)).toBe(0)
    expect(windowStart(Array(41).fill(1), limits)).toBe(10)
    expect(windowStart(Array(50).fill(1), limits)).toBe(10)
    expect(windowStart(Array(51).fill(1), limits)).toBe(20)
  })

  it("cuts further when the history is too big, but always keeps the newest turn", () => {
    expect(windowStart(Array(30).fill(50), limits)).toBe(10) // 1,500 chars -> 1,000
    expect(windowStart([10, 10, 5_000], limits)).toBe(2)
  })
})
