import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PerfDriver, PerfResult, RaceData } from "@/lib/race-performance"

const db = vi.hoisted(() => ({ event: { findMany: vi.fn() } }))
const loader = vi.hoisted(() => ({ loadRaceData: vi.fn() }))
const seasons = vi.hoisted(() => ({ resolveLeagueSeason: vi.fn(), DEFAULT_LEAGUE: "lone-star-cup" }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/queries/race-performance", () => loader)
vi.mock("./seasons", () => seasons)

import { filterSessions, matchDrivers, racePerformanceTool } from "./race-performance"

const ctx = { roomId: "room-1", actor: { userId: "officer-1", displayName: "Gray" } }
const alex: PerfDriver = { key: "u-alex", name: "Alex Kim", handle: "alexk", userId: "u-alex" }
const alexa: PerfDriver = { key: "u-alexa", name: "Alexa Diaz", handle: "alexa", userId: "u-alexa" }
const guest: PerfDriver = { key: "guid:7", name: "SimGuest", handle: null, userId: null }

const result = (sessionId: string, driver: PerfDriver, position: number, extra: Partial<PerfResult> = {}): PerfResult => ({
  sessionId,
  participantId: `${sessionId}-${driver.key}`,
  driver,
  driverGuid: driver.key,
  car: "GT3",
  position,
  bestLapMs: 95_000 + position * 300,
  laps: 12,
  cuts: position,
  collisions: 0,
  dsq: false,
  points: 26 - position,
  ...extra,
})

const data: RaceData = {
  sessions: [
    { id: "q1", type: "QUALIFYING", track: "monza", startedAt: new Date("2026-10-05T22:00:00Z"), event: { id: "e1", title: "LSC Round 1 @ Monza", slug: "lsc-r1", startsAt: new Date("2026-10-05T23:00:00Z") } },
    { id: "r1", type: "RACE", track: "monza", startedAt: new Date("2026-10-05T23:00:00Z"), event: { id: "e1", title: "LSC Round 1 @ Monza", slug: "lsc-r1", startsAt: new Date("2026-10-05T23:00:00Z") } },
    { id: "r2", type: "RACE", track: "spa", startedAt: new Date("2026-10-12T23:00:00Z"), event: { id: "e2", title: "LSC Round 2 @ Spa", slug: "lsc-r2", startsAt: new Date("2026-10-12T23:00:00Z") } },
  ],
  results: [result("q1", alexa, 1), result("q1", alex, 2), result("r1", alex, 1), result("r1", alexa, 2), result("r1", guest, 3), result("r2", alexa, 1), result("r2", alex, 2)],
  laps: [],
  incidents: [],
}

beforeEach(() => {
  seasons.resolveLeagueSeason.mockResolvedValue({ ok: true, season: { id: "s3", name: "Season 3", seriesId: "series-1", startAt: new Date("2026-09-01"), endAt: new Date("2026-12-01") }, seasons: ["lone-star-cup-s3"] })
  db.event.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }])
  loader.loadRaceData.mockResolvedValue(data)
})

const run = (input: Record<string, unknown>) => racePerformanceTool.run(racePerformanceTool.input.parse(input), ctx)

describe("matchDrivers", () => {
  const drivers = [alex, alexa, guest, alex]
  it("takes an exact handle or name first, then a unique part of one", () => {
    expect(matchDrivers(["@alexk"], drivers)).toEqual({ ok: true, keys: ["u-alex"] })
    expect(matchDrivers(["Alexa Diaz", "simg"], drivers)).toEqual({ ok: true, keys: ["u-alexa", "guid:7"] })
  })

  it("asks for a handle when a name is ambiguous, and lists who's there when nobody matches", () => {
    expect(matchDrivers(["alex"], drivers)).toEqual({ ok: false, error: '"alex" matches several drivers: Alex Kim (@alexk), Alexa Diaz (@alexa). Use a handle.' })
    expect(matchDrivers(["zed"], drivers)).toEqual({ ok: false, error: expect.stringContaining("Drivers: Alex Kim (@alexk), Alexa Diaz (@alexa), SimGuest") })
  })
})

describe("race_performance", () => {
  it("reads a season's rounds (its series' events between its dates) and always states the data's limits", async () => {
    const out = await run({})
    expect(db.event.findMany).toHaveBeenCalledWith({ where: { seriesId: "series-1", startsAtUtc: { gte: new Date("2026-09-01"), lte: new Date("2026-12-01") } }, select: { id: true } })
    expect(loader.loadRaceData).toHaveBeenCalledWith({ eventIds: ["e1", "e2"], withLaps: true, withIncidents: true }, expect.any(Date))
    const body = JSON.parse(out.forModel)
    expect(body.dataLimits).toMatch(/No DNF is recorded/)
    expect(body.dataLimits).toMatch(/classPosition is always 0/)
    expect(body.sessions).toEqual({ races: 2, qualifying: 1, practice: 0 })
    expect(body.drivers.map((d: { driver: string }) => d.driver)).toEqual(["Alex Kim (@alexk)", "Alexa Diaz (@alexa)", "SimGuest (not linked to a member)"])
    expect(body.drivers[0].positionsGained).toEqual({ total: 1, perRace: 1, racesWithQualifying: 1 })
  })

  it("reads every session for season all", async () => {
    await run({ season: "all" })
    expect(seasons.resolveLeagueSeason).not.toHaveBeenCalled()
    expect(loader.loadRaceData).toHaveBeenCalledWith({ eventIds: undefined, withLaps: true, withIncidents: true }, expect.any(Date))
  })

  it("filters to a track or a round", async () => {
    const body = JSON.parse((await run({ track: "SPA", focus: "rounds" })).forModel)
    expect(body.rounds.map((r: { round: string }) => r.round)).toEqual(["LSC Round 2 @ Spa"])
    const none = await run({ round: "Round 9" })
    expect(JSON.parse(none.forModel).note).toMatch(/No uploaded sessions match/)
  })

  it("follows one driver's trend, and needs exactly one", async () => {
    const out = await run({ focus: "trend", drivers: ["alexk"] })
    const body = JSON.parse(out.forModel)
    expect(body.driver).toBe("Alex Kim (@alexk)")
    expect(body.races.map((r: { finish: string }) => r.finish)).toEqual(["P1 of 3", "P2 of 2"])
    expect(out.label).toBe("Looked at Alex Kim's results (2 races, too few races)")
    expect(await run({ focus: "trend" })).toMatchObject({ isError: true, forModel: "trend needs exactly one driver in drivers." })
  })

  it("puts two drivers head to head, and needs exactly two", async () => {
    const out = await run({ focus: "head_to_head", drivers: ["alexk", "alexa"] })
    const body = JSON.parse(out.forModel)
    expect(body.summary).toMatchObject({ racesTogether: 2, finishedAhead: { "Alex Kim": 1, "Alexa Diaz": 1 }, qualifyingTogether: 1, qualifiedAhead: { "Alex Kim": 0, "Alexa Diaz": 1 } })
    expect(out.displays?.[0]).toMatchObject({ kind: "stats" })
    expect(await run({ focus: "head_to_head", drivers: ["alexk"] })).toMatchObject({ isError: true })
  })

  it("caps each list at the limit and says how many there were", async () => {
    const body = JSON.parse((await run({ limit: 1 })).forModel)
    expect(body.drivers).toHaveLength(1)
    expect(body.driversTotal).toBe(3)
  })

  it("passes on a season it can't find, and a season with no series", async () => {
    seasons.resolveLeagueSeason.mockResolvedValueOnce({ ok: false, error: 'No Lone Star Cup season "s9".' })
    expect(await run({ season: "s9" })).toMatchObject({ isError: true, forModel: 'No Lone Star Cup season "s9".' })
    seasons.resolveLeagueSeason.mockResolvedValueOnce({ ok: true, season: { id: "s1", name: "Season 1", seriesId: null }, seasons: [] })
    expect(await run({})).toMatchObject({ isError: true, forModel: expect.stringContaining('season "all"') })
  })

  it("is deferred behind tool search", () => {
    expect(racePerformanceTool.deferred).toBe(true)
  })
})

describe("filterSessions", () => {
  it("keeps the rows of the sessions it keeps", () => {
    const kept = filterSessions(data, (s) => s.id === "r2")
    expect(kept.sessions.map((s) => s.id)).toEqual(["r2"])
    expect(kept.results.every((r) => r.sessionId === "r2")).toBe(true)
  })
})
