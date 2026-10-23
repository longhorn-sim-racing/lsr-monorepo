import { describe, expect, it } from "vitest"
import {
  bestLapBySession,
  cleanLapsBySession,
  driverKey,
  driverTrend,
  formatLap,
  headToHead,
  lapOrNull,
  lapStats,
  lapsByTrack,
  personalBests,
  positionsGained,
  recentForm,
  summarizeDrivers,
  summarizeRounds,
  trackLabel,
  trackRecords,
  trendDirection,
  type PerfDriver,
  type PerfLap,
  type PerfResult,
  type RaceData,
} from "./race-performance"

const alex: PerfDriver = { key: "u-alex", name: "Alex", handle: "alex", userId: "u-alex" }
const blake: PerfDriver = { key: "u-blake", name: "Blake", handle: "blake", userId: "u-blake" }
const guest: PerfDriver = { key: "guid:777", name: "SimGuest", handle: null, userId: null }
const guidOf: Record<string, string> = { "u-alex": "111", "u-blake": "222", "guid:777": "777" }

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 5, h, m))
const e1 = { id: "e1", title: "LSC Round 1 @ Monza", slug: "lsc-r1", startsAt: at(23) }
const e2 = { id: "e2", title: "LSC Round 2 @ Spa", slug: "lsc-r2", startsAt: new Date(Date.UTC(2026, 9, 12, 23)) }

function result(sessionId: string, driver: PerfDriver, position: number, extra: Partial<PerfResult> = {}): PerfResult {
  return { sessionId, participantId: `${sessionId}-${driver.key}`, driver, driverGuid: guidOf[driver.key], car: "GT3", position, bestLapMs: null, laps: 10, cuts: 0, collisions: 0, dsq: false, points: null, ...extra }
}

function laps(sessionId: string, driver: PerfDriver, times: (number | [number, false])[]): PerfLap[] {
  return times.map((t, i) => ({ sessionId, participantId: `${sessionId}-${driver.key}`, lapNumber: i + 1, lapMs: Array.isArray(t) ? t[0] : t, valid: !Array.isArray(t), cuts: Array.isArray(t) ? 1 : 0 }))
}

/** Round 1 has qualifying and a race at Monza; round 2 only a race at Spa */
const data: RaceData = {
  sessions: [
    { id: "q1", type: "QUALIFYING", track: "monza", startedAt: at(22), event: e1 },
    { id: "r1", type: "RACE", track: "monza", startedAt: at(23), event: e1 },
    { id: "r2", type: "RACE", track: "spa", startedAt: new Date(Date.UTC(2026, 9, 12, 23)), event: e2 },
  ],
  results: [
    result("q1", blake, 1, { bestLapMs: 94_000 }),
    result("q1", alex, 2, { bestLapMs: 94_500 }),
    result("q1", guest, 3, { bestLapMs: 99_000 }),
    result("r1", alex, 1, { points: 25, cuts: 0, collisions: 1 }),
    result("r1", blake, 2, { points: 18, cuts: 2 }),
    result("r1", guest, 3, { points: 15, cuts: 1, collisions: 3 }),
    result("r2", blake, 1, { points: 25, bestLapMs: 130_000 }),
    result("r2", alex, 2, { points: 18, bestLapMs: 131_000, dsq: false }),
  ],
  laps: [
    // Lap 1 (start) and lap 7 (slower than 107%) aren't clean; lap 8 has a cut
    ...laps("r1", alex, [104_000, 95_000, 95_400, 95_200, 95_600, 95_100, 125_000, [93_000, false]]),
    ...laps("r1", blake, [104_500, 95_800, 96_400, 95_900, 96_100, 96_700]),
    ...laps("r1", guest, [110_000, 99_000]),
  ],
  incidents: [
    { sessionId: "r1", participantId: "r1-u-alex", type: "COLLISION_WITH_CAR", count: 1 },
    { sessionId: "r1", participantId: "r1-guid:777", type: "COLLISION_WITH_ENV", count: 2 },
    { sessionId: "r1", participantId: "r1-guid:777", type: "COLLISION_WITH_CAR", count: 1 },
  ],
}

describe("lap helpers", () => {
  it("treats AC's no-lap values as no lap, and formats lap times", () => {
    expect(lapOrNull(999_999_999)).toBeNull()
    expect(lapOrNull(0)).toBeNull()
    expect(lapOrNull(null)).toBeNull()
    expect(formatLap(105_800)).toBe("1:45.800")
    expect(formatLap(59_001)).toBe("0:59.001")
    expect(formatLap(999_999_999)).toBeNull()
  })

  it("names tracks with their layout, and drivers by member or sim id", () => {
    expect(trackLabel("ks_nordschleife", "endurance")).toBe("ks_nordschleife (endurance)")
    expect(trackLabel("monza", " ")).toBe("monza")
    expect(driverKey("u1", "123")).toBe("u1")
    expect(driverKey(null, "123")).toBe("guid:123")
  })

  it("keeps clean laps: valid, not the first, within 107% of the session best", () => {
    const clean = cleanLapsBySession(data.laps)
    expect(clean.get("r1:r1-u-alex")).toEqual([95_000, 95_400, 95_200, 95_600, 95_100])
    expect(clean.get("r1:r1-guid:777")).toEqual([99_000])
  })

  it("measures spread as a standard deviation and a % of the mean", () => {
    expect(lapStats([])).toBeNull()
    expect(lapStats([90_000])).toEqual({ count: 1, bestMs: 90_000, meanMs: 90_000, spreadMs: 0, spreadPct: 0 })
    const stats = lapStats([95_000, 95_400, 95_200, 95_600, 95_100])!
    expect(stats).toMatchObject({ count: 5, bestMs: 95_000, meanMs: 95_260, spreadMs: 241 })
    expect(stats.spreadPct).toBeCloseTo(0.25, 2)
  })

  it("takes the best valid lap from laps, and the file's best lap only for sessions without laps", () => {
    const best = bestLapBySession(data)
    expect(best.get("r1:r1-u-alex")).toBe(95_000) // the cut 1:33.0 doesn't count
    expect(best.get("q1:q1-u-blake")).toBe(94_000)
    expect(best.get("r2:r2-u-alex")).toBe(131_000)
  })
})

describe("positions gained", () => {
  it("compares the event's qualifying position with the race finish, by sim driver", () => {
    const gained = positionsGained(data)
    expect(gained.get("r1:r1-u-alex")).toEqual({ grid: 2, gained: 1 })
    expect(gained.get("r1:r1-u-blake")).toEqual({ grid: 1, gained: -1 })
    expect(gained.get("r1:r1-guid:777")).toEqual({ grid: 3, gained: 0 })
    // Round 2 had no qualifying uploaded
    expect(gained.has("r2:r2-u-alex")).toBe(false)
  })
})

describe("summarizeDrivers", () => {
  it("adds up races, finishes, points, positions gained and incidents, best points first", () => {
    const [first, second, third] = summarizeDrivers(data)
    expect(first).toMatchObject({ driver: alex, races: 2, wins: 1, podiums: 2, averageFinish: 1.5, bestFinish: 1, points: 43, racesWithGrid: 1, positionsGained: 1, averageGained: 1 })
    expect(first).toMatchObject({ cuts: 0, collisions: 1, collisionsWithCars: 1, collisionsWithEnv: 0, incidentsPerRace: 0.5, cleanLaps: 5 })
    expect(first.consistencyPct).toBeCloseTo(0.25, 2)
    expect(second).toMatchObject({ driver: blake, points: 43, positionsGained: -1, cuts: 2, incidentsPerRace: 1 })
    expect(third).toMatchObject({ driver: guest, races: 1, collisions: 3, collisionsWithCars: 1, collisionsWithEnv: 2, incidentsPerRace: 4, consistencyPct: null })
  })
})

describe("lapsByTrack and trackRecords", () => {
  it("gives each driver's best and average clean lap per track, with the gap to the track's best", () => {
    const rows = lapsByTrack(data)
    expect(rows.map((r) => [r.track, r.driver.name, r.bestLapMs, r.gapPct])).toEqual([
      ["monza", "Alex", 95_000, 0],
      ["monza", "Blake", 95_800, 0.84],
      ["monza", "SimGuest", 99_000, 4.21],
      ["spa", "Blake", 130_000, 0],
      ["spa", "Alex", 131_000, 0.77],
    ])
    expect(rows[0]).toMatchObject({ averageLapMs: 95_260, cleanLaps: 5, spreadMs: 241, sessions: 1 })
    // From qualifying too, when asked
    expect(lapsByTrack(data, ["QUALIFYING"]).map((r) => [r.driver.name, r.bestLapMs])).toEqual([
      ["Blake", 94_000],
      ["Alex", 94_500],
      ["SimGuest", 99_000],
    ])
  })

  it("names the fastest lap at each track over every session type", () => {
    expect(trackRecords(data).map((r) => [r.track, r.driver.name, r.bestLapMs, r.drivers])).toEqual([
      ["monza", "Blake", 94_000, 3],
      ["spa", "Blake", 130_000, 2],
    ])
  })
})

describe("rounds, trends and head-to-heads", () => {
  it("summarizes each round's race: winner, fastest lap and incidents", () => {
    expect(summarizeRounds(data).map((r) => [r.event.slug, r.winner?.name, r.fastestLap?.driver.name, r.fastestLap?.lapMs, r.incidents, r.drivers])).toEqual([
      ["lsc-r1", "Alex", "Alex", 95_000, 7, 3],
      ["lsc-r2", "Blake", "Blake", 130_000, 0, 2],
    ])
  })

  it("follows one driver's races in order, with the gap to each race's fastest lap", () => {
    const rows = driverTrend(data, "u-alex")
    expect(rows.map((r) => [r.event?.slug, r.position, r.field, r.gained, r.gapToFastestPct])).toEqual([
      ["lsc-r1", 1, 3, 1, 0],
      ["lsc-r2", 2, 2, null, 0.77],
    ])
    expect(trendDirection(rows).direction).toBe("too few races")
    expect(trendDirection([{ position: 5 }, { position: 4 }, { position: 2 }, { position: 1 }])).toEqual({ earlier: 4.5, later: 1.5, direction: "improving" })
    expect(trendDirection([{ position: 2 }, { position: 2 }, { position: 2 }, { position: 2 }]).direction).toBe("steady")
  })

  it("compares two drivers in the sessions they shared", () => {
    const h2h = headToHead(data, "u-alex", "u-blake")
    expect(h2h).toMatchObject({ races: 2, aAhead: 1, bAhead: 1, qualifying: 1, aAheadInQualifying: 0, bAheadInQualifying: 1 })
    // Qualifying +500, race 1 -800, race 2 +1000
    expect(h2h.averageLapGapMs).toBe(233)
    expect(h2h.sessions.map((s) => s.type)).toEqual(["QUALIFYING", "RACE", "RACE"])
  })

  it("shows recent form for drivers in the latest races, best average first", () => {
    const form = recentForm(data, { races: 5, activeSessions: 1 })
    // Only round 2's drivers are recent
    expect(form.map((f) => [f.driver.name, f.races.map((r) => r.position), f.averageFinish, f.gained])).toEqual([
      ["Alex", [1, 2], 1.5, 1],
      ["Blake", [2, 1], 1.5, -1],
    ])
  })

  it("lists one driver's best lap per track and where it came from, newest first", () => {
    expect(personalBests(data, "u-alex").map((b) => [b.track, b.bestLapMs, b.sessionType, b.event?.slug])).toEqual([
      ["spa", 131_000, "RACE", "lsc-r2"],
      ["monza", 94_500, "QUALIFYING", "lsc-r1"],
    ])
  })
})
