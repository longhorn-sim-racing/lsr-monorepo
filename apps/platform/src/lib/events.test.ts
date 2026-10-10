import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStatus, Visibility } from "@prisma/client"
import { getEffectiveEventStatus, isEventLive, isEventPublic } from "./events"

const NOW = new Date("2026-10-16T18:00:00Z")
const hours = (n: number) => new Date(NOW.getTime() + n * 36e5)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("getEffectiveEventStatus", () => {
  const timing = { startsAtUtc: hours(1), endsAtUtc: hours(3) }

  it("keeps drafts, cancellations and postponements as they are", () => {
    for (const status of [EventStatus.DRAFT, EventStatus.CANCELLED, EventStatus.POSTPONED]) {
      expect(getEffectiveEventStatus({ status, ...timing })).toBe(status)
    }
  })

  it("derives upcoming, live and completed from the times", () => {
    expect(getEffectiveEventStatus({ status: EventStatus.PUBLISHED, ...timing })).toBe(EventStatus.PUBLISHED)
    expect(getEffectiveEventStatus({ status: EventStatus.PUBLISHED, startsAtUtc: hours(-1), endsAtUtc: hours(1) })).toBe(
      EventStatus.IN_PROGRESS
    )
    expect(getEffectiveEventStatus({ status: EventStatus.PUBLISHED, startsAtUtc: hours(-3), endsAtUtc: hours(-1) })).toBe(
      EventStatus.COMPLETED
    )
  })

  it("keeps a scheduled event hidden until its publish time", () => {
    expect(getEffectiveEventStatus({ status: EventStatus.SCHEDULED, publishedAt: hours(1), ...timing })).toBe(EventStatus.SCHEDULED)
    expect(getEffectiveEventStatus({ status: EventStatus.SCHEDULED, publishedAt: null, ...timing })).toBe(EventStatus.SCHEDULED)
    expect(getEffectiveEventStatus({ status: EventStatus.SCHEDULED, publishedAt: hours(-1), ...timing })).toBe(EventStatus.PUBLISHED)
  })
})

describe("isEventPublic", () => {
  const event = (status: EventStatus, extra: { publishedAt?: Date | null; visibility?: Visibility } = {}) => ({
    status,
    visibility: Visibility.public,
    ...extra,
  })

  it("hides drafts and non-public events", () => {
    expect(isEventPublic(event(EventStatus.DRAFT))).toBe(false)
    for (const visibility of Object.values(Visibility).filter((v) => v !== Visibility.public)) {
      expect(isEventPublic(event(EventStatus.PUBLISHED, { visibility }))).toBe(false)
    }
  })

  it("shows a scheduled event only once its publish time has passed", () => {
    expect(isEventPublic(event(EventStatus.SCHEDULED, { publishedAt: hours(1) }))).toBe(false)
    expect(isEventPublic(event(EventStatus.SCHEDULED, { publishedAt: null }))).toBe(false)
    expect(isEventPublic(event(EventStatus.SCHEDULED, { publishedAt: hours(-1) }))).toBe(true)
  })

  it("shows published, cancelled and postponed events", () => {
    for (const status of [EventStatus.PUBLISHED, EventStatus.CANCELLED, EventStatus.POSTPONED]) {
      expect(isEventPublic(event(status))).toBe(true)
    }
  })
})

describe("isEventLive", () => {
  it("is true only while a published event is running", () => {
    expect(isEventLive({ status: EventStatus.PUBLISHED, startsAtUtc: hours(-1), endsAtUtc: hours(1) })).toBe(true)
    expect(isEventLive({ status: EventStatus.PUBLISHED, startsAtUtc: hours(1), endsAtUtc: hours(2) })).toBe(false)
    expect(isEventLive({ status: EventStatus.DRAFT, startsAtUtc: hours(-1), endsAtUtc: hours(1) })).toBe(false)
    expect(isEventLive({ status: EventStatus.CANCELLED, startsAtUtc: hours(-1), endsAtUtc: hours(1) })).toBe(false)
  })
})
