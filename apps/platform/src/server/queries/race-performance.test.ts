import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  raceSession: { findMany: vi.fn() },
  raceResult: { findMany: vi.fn() },
  raceLap: { findMany: vi.fn() },
  raceEvent: { groupBy: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { publicEventWhere } from "@/lib/events"
import { publicUserSelect } from "@/lib/public-user"
import { loadRaceData } from "./race-performance"

const now = new Date("2026-10-22T12:00:00Z")

beforeEach(() => {
  db.raceSession.findMany.mockResolvedValue([
    { id: "r1", sessionType: "RACE", trackName: "ks_nordschleife", trackConfig: "endurance", startedAt: new Date("2026-10-05T23:00:00Z"), event: { id: "e1", title: "Round 1", slug: "r1", startsAtUtc: new Date("2026-10-05T23:00:00Z") } },
  ])
  db.raceResult.findMany.mockResolvedValue([
    {
      sessionId: "r1",
      participantId: "p1",
      position: 1,
      bestLapTime: 480_000,
      lapsCompleted: 3,
      totalCuts: null,
      collisionCount: 2,
      isDisqualified: false,
      status: "FINISHED",
      points: 25,
      participant: { driverGuid: "765", displayName: "SimName", carName: "ks_porsche", carMapping: { displayName: "Porsche 911 GT3" }, user: { id: "u1", handle: "alex", displayName: "Alex" } },
    },
    {
      sessionId: "r1",
      participantId: "p2",
      position: 2,
      bestLapTime: 999_999_999,
      lapsCompleted: 0,
      totalCuts: 1,
      collisionCount: null,
      isDisqualified: false,
      status: "DSQ",
      points: 0,
      participant: { driverGuid: "888", displayName: "Guest Driver", carName: "ks_bmw", carMapping: null, user: null },
    },
  ])
  db.raceLap.findMany.mockResolvedValue([{ sessionId: "r1", participantId: "p1", lapNumber: 1, lapTime: 490_000, valid: true, cuts: null }])
  db.raceEvent.groupBy.mockResolvedValue([
    { sessionId: "r1", participantId: "p1", type: "COLLISION_WITH_ENV", _count: { _all: 2 } },
    { sessionId: "r1", participantId: null, type: "COLLISION_WITH_CAR", _count: { _all: 1 } },
  ])
})

describe("loadRaceData", () => {
  it("keeps to public events for public pages, and selects members only through publicUserSelect", async () => {
    await loadRaceData({ publicOnly: true, userId: "u1" }, now)
    expect(db.raceSession.findMany.mock.calls[0][0].where).toEqual({ event: publicEventWhere(now), participants: { some: { userId: "u1" } } })
    expect(db.raceResult.findMany.mock.calls[0][0].select.participant.select.user).toEqual({ select: publicUserSelect })
    expect(publicUserSelect).not.toHaveProperty("email")
    expect(publicUserSelect).not.toHaveProperty("eid")
  })

  it("reads laps and collisions only when asked", async () => {
    const plain = await loadRaceData({ eventIds: ["e1"] }, now)
    expect(db.raceSession.findMany.mock.calls[0][0].where).toEqual({ eventId: { in: ["e1"] } })
    expect(db.raceLap.findMany).not.toHaveBeenCalled()
    expect(db.raceEvent.groupBy).not.toHaveBeenCalled()
    expect(plain.laps).toEqual([])

    const full = await loadRaceData({ withLaps: true, withIncidents: true }, now)
    expect(full.laps).toEqual([{ sessionId: "r1", participantId: "p1", lapNumber: 1, lapMs: 490_000, valid: true, cuts: 0 }])
    expect(full.incidents).toEqual([{ sessionId: "r1", participantId: "p1", type: "COLLISION_WITH_ENV", count: 2 }])
  })

  it("names members by their profile and unlinked drivers by the file's name, with the track's layout", async () => {
    const { sessions, results } = await loadRaceData({}, now)
    expect(sessions[0]).toMatchObject({ type: "RACE", track: "ks_nordschleife (endurance)", event: { slug: "r1" } })
    expect(results.map((r) => [r.driver, r.car, r.cuts, r.collisions, r.dsq])).toEqual([
      [{ key: "u1", name: "Alex", handle: "alex", userId: "u1" }, "Porsche 911 GT3", 0, 2, false],
      [{ key: "guid:888", name: "Guest Driver", handle: null, userId: null }, "ks_bmw", 1, 0, true],
    ])
  })

  it("reads nothing more when no session matches", async () => {
    db.raceSession.findMany.mockResolvedValue([])
    expect(await loadRaceData({ eventIds: [] }, now)).toEqual({ sessions: [], results: [], laps: [], incidents: [] })
    expect(db.raceResult.findMany).not.toHaveBeenCalled()
  })
})
