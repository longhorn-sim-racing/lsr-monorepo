import { describe, expect, it } from "vitest"
import { agendaText, daysOverdue, decisionBody, decisionTitle, dueDateValue, formatMeetingTime, isOverdue, meetingTimeInput, meetingTimeKnown, meetingTimeValue, weekdayDate } from "./meetings"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu Oct 22, noon Central

describe("due dates and overdue", () => {
  it("stores a due date as the start of its Central day", () => {
    expect(dueDateValue("2026-10-30")).toEqual(new Date("2026-10-30T05:00:00Z"))
    expect(weekdayDate(dueDateValue("2026-10-30"))).toBe("Fri 2026-10-30")
  })

  it("is overdue from the day after it's due, and only while open", () => {
    expect(isOverdue({ status: "open", dueAt: dueDateValue("2026-10-21") }, NOW)).toBe(true)
    expect(isOverdue({ status: "open", dueAt: dueDateValue("2026-10-22") }, NOW)).toBe(false)
    expect(isOverdue({ status: "done", dueAt: dueDateValue("2026-10-01") }, NOW)).toBe(false)
    expect(isOverdue({ status: "open", dueAt: null }, NOW)).toBe(false)
  })

  it("counts whole Central days overdue, across a daylight-saving change", () => {
    expect(daysOverdue({ status: "open", dueAt: dueDateValue("2026-10-19") }, NOW)).toBe(3)
    expect(daysOverdue({ status: "open", dueAt: dueDateValue("2026-10-22") }, NOW)).toBe(0)
    // Nov 1 is the end of daylight time
    expect(daysOverdue({ status: "open", dueAt: dueDateValue("2026-10-31") }, new Date("2026-11-02T18:00:00Z"))).toBe(2)
  })
})

describe("meeting times", () => {
  it("keeps a meeting without a time at the start of its day, and shows no time for it", () => {
    const day = meetingTimeValue("2026-10-19")
    expect(day).toEqual(new Date("2026-10-19T05:00:00Z"))
    expect(meetingTimeKnown(day)).toBe(false)
    expect(formatMeetingTime(day)).toBe("Mon, Oct 19, 2026")
    expect(meetingTimeInput(day)).toBe("")
  })

  it("shows the time when there is one", () => {
    const evening = meetingTimeValue("2026-10-19", "18:30")
    expect(evening).toEqual(new Date("2026-10-19T23:30:00Z"))
    expect(formatMeetingTime(evening)).toBe("Mon, Oct 19, 2026, 6:30 PM")
    expect(meetingTimeInput(evening)).toBe("18:30")
  })
})

describe("decisions in the decision log", () => {
  it("titles a decision with its first sentence, cut at a word", () => {
    expect(decisionTitle("Keep the four sponsor tiers for 2026-27. Revisit in spring.")).toBe("Keep the four sponsor tiers for 2026-27")
    const long = `We will ${"really ".repeat(30)}do it`
    const title = decisionTitle(long)
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith("…")).toBe(true)
    expect(title).not.toMatch(/ …$/)
    // Long enough for the knowledge base's title rule
    expect(decisionTitle("No.")).toBe("Decision: No")
  })

  it("writes the decision with where it was made", () => {
    expect(decisionBody("No dues this semester.", { title: "Board meeting", heldAt: meetingTimeValue("2026-09-29", "19:00") })).toBe("No dues this semester.\n\nDecided at Board meeting, Sep 29, 2026.")
  })
})

it("copies an agenda as plain text: title, when, then the agenda", () => {
  expect(agendaText({ title: "GM 2", heldAt: meetingTimeValue("2026-10-26", "18:00"), agendaMd: "1. Welcome\n2. LSC update\n" })).toBe("GM 2\nMon, Oct 26, 2026, 6:00 PM\n\n1. Welcome\n2. LSC update")
})
