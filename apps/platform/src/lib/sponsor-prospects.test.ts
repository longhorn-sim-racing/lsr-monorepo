import { describe, expect, it } from "vitest"
import { companyKey, isNextStepOverdue, isQuietProspect, lastTouch, parseProspectStage, parseTier, stageChangeSummary } from "./sponsor-prospects"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu Oct 22, noon Central
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe("companyKey", () => {
  it("matches names without case, spacing, punctuation or a trailing company suffix", () => {
    expect(companyKey("Acme, Inc.")).toBe("acme")
    expect(companyKey("  ACME  ")).toBe("acme")
    expect(companyKey("Acme LLC")).toBe("acme")
    expect(companyKey("Red Bull Racing")).toBe("red bull racing")
  })

  it("leaves a name that is only a suffix-looking word, or has one in the middle", () => {
    expect(companyKey("Co-op Sim")).toBe("co-op sim")
    expect(companyKey("Inc")).toBe("inc")
  })
})

describe("parsing what someone typed", () => {
  it("takes a stage's key or label in any case", () => {
    expect(parseProspectStage("Talking")).toBe("talking")
    expect(parseProspectStage(" committed ")).toBe("committed")
    expect(parseProspectStage("maybe")).toBeNull()
  })

  it("takes a tier's id, short name or full name", () => {
    expect(parseTier("gold")).toBe("gold")
    expect(parseTier("Gold Partner")).toBe("gold")
    expect(parseTier("Friend of LSR")).toBe("friend")
    expect(parseTier("Diamond")).toBeNull()
  })
})

describe("quiet prospects", () => {
  const base = { stage: "talking", createdAt: daysAgo(90), lastContactAt: null as Date | null, lastActivityAt: null as Date | null }

  it("counts from the newest of the activity, the last contact and when it was added", () => {
    expect(lastTouch({ ...base, lastContactAt: daysAgo(30), lastActivityAt: daysAgo(10) })).toEqual(daysAgo(10))
    expect(lastTouch({ ...base, lastContactAt: daysAgo(5) })).toEqual(daysAgo(5))
    expect(lastTouch(base)).toEqual(daysAgo(90))
  })

  it("is quiet after 21 days in contacted or talking, and never in other stages", () => {
    expect(isQuietProspect({ ...base, lastActivityAt: daysAgo(21) }, NOW)).toBe(true)
    expect(isQuietProspect({ ...base, lastActivityAt: daysAgo(20) }, NOW)).toBe(false)
    expect(isQuietProspect({ ...base, stage: "contacted", lastActivityAt: daysAgo(40) }, NOW)).toBe(true)
    for (const stage of ["idea", "researching", "committed", "declined", "dormant"]) expect(isQuietProspect({ ...base, stage }, NOW), stage).toBe(false)
  })
})

describe("isNextStepOverdue", () => {
  it("is overdue from the day after it's due (Central), on open stages only", () => {
    const dueYesterday = new Date("2026-10-21T05:00:00Z") // Oct 21, midnight Central
    const dueToday = new Date("2026-10-22T05:00:00Z")
    expect(isNextStepOverdue({ stage: "talking", nextStepDue: dueYesterday }, NOW)).toBe(true)
    expect(isNextStepOverdue({ stage: "talking", nextStepDue: dueToday }, NOW)).toBe(false)
    expect(isNextStepOverdue({ stage: "committed", nextStepDue: dueYesterday }, NOW)).toBe(false)
    expect(isNextStepOverdue({ stage: "talking", nextStepDue: null }, NOW)).toBe(false)
  })
})

it("describes a stage change with labels", () => {
  expect(stageChangeSummary("contacted", "talking")).toBe("Stage: Contacted → Talking")
})
