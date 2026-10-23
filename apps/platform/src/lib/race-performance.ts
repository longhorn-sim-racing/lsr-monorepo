/**
 * Race performance from uploaded results (#188): lap times, consistency, incidents, positions gained,
 * form and head-to-heads. Pure functions over rows a loader already read, shared by Jack's
 * race_performance tool, the Results admin page and the public driver profile.
 *
 * What the data can't say (every summary repeats it): no DNF is ever recorded (a driver in the
 * results is FINISHED or DSQ, however few laps they did), classPosition is always 0, laps carry no
 * running position, and positions gained needs a qualifying session uploaded for the same event.
 */

export const RACE_DATA_LIMITS =
  "Uploaded sim results only. No DNF is recorded (everyone classified is FINISHED or DSQ, however few laps they did, so compare laps completed), classPosition is always 0, laps have no running position, and positions gained needs a qualifying session uploaded for the same event. Clean laps leave out invalid laps (cuts), each driver's first lap of a session, and laps slower than 107% of their best in that session."

export type SessionType = "RACE" | "QUALIFYING" | "PRACTICE"

export type PerfSession = {
  id: string
  type: string
  /** The track as the sim names it, with its layout: "monza", "ks_nordschleife (endurance)" */
  track: string
  startedAt: Date
  event: { id: string; title: string; slug: string; startsAt: Date } | null
}

/** A driver: a member when the sim driver is linked to one, otherwise the name from the results file */
export type PerfDriver = { key: string; name: string; handle: string | null; userId: string | null }

export type PerfResult = {
  sessionId: string
  participantId: string
  driver: PerfDriver
  driverGuid: string
  car: string
  /** 1-based finishing (or classification) position */
  position: number
  bestLapMs: number | null
  laps: number
  cuts: number
  collisions: number
  dsq: boolean
  points: number | null
}

export type PerfLap = { sessionId: string; participantId: string; lapNumber: number; lapMs: number; valid: boolean; cuts: number }

/** RaceEvent rows counted per driver, session and type (COLLISION_WITH_CAR, COLLISION_WITH_ENV) */
export type PerfIncident = { sessionId: string; participantId: string; type: string; count: number }

export type RaceData = { sessions: PerfSession[]; results: PerfResult[]; laps: PerfLap[]; incidents: PerfIncident[] }

/** A stored best lap, or null: AC writes a huge sentinel (or 0) when a driver set no lap */
export function lapOrNull(ms: number | null | undefined): number | null {
  return typeof ms === "number" && ms > 0 && ms < 3_600_000 ? ms : null
}

/** 105800 → "1:45.800" */
export function formatLap(ms: number | null | undefined): string | null {
  const lap = lapOrNull(ms)
  if (lap === null) return null
  const minutes = Math.floor(lap / 60_000)
  const seconds = ((lap % 60_000) / 1000).toFixed(3).padStart(6, "0")
  return `${minutes}:${seconds}`
}

/** A track as it's shown: its sim name, with the layout when there is one */
export function trackLabel(name: string, config: string | null | undefined): string {
  return config?.trim() ? `${name} (${config.trim()})` : name
}

/** The key that groups one driver's rows: their member id, or their sim id when they aren't linked */
export function driverKey(userId: string | null, driverGuid: string): string {
  return userId ?? `guid:${driverGuid}`
}

const round2 = (n: number) => Math.round(n * 100) / 100

export type LapStats = { count: number; bestMs: number; meanMs: number; spreadMs: number; spreadPct: number }

/** Best, mean and spread (standard deviation, and as a % of the mean) of lap times; null for none */
export function lapStats(times: number[]): LapStats | null {
  if (!times.length) return null
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const variance = times.length > 1 ? times.reduce((a, t) => a + (t - mean) ** 2, 0) / (times.length - 1) : 0
  const spread = Math.sqrt(variance)
  return { count: times.length, bestMs: Math.min(...times), meanMs: Math.round(mean), spreadMs: Math.round(spread), spreadPct: round2((spread / mean) * 100) }
}

const groupKey = (sessionId: string, participantId: string) => `${sessionId}:${participantId}`

/**
 * Each driver's clean laps per session: valid (no cuts), not their first lap (a standing start, or an
 * out lap), and within 107% of their best valid lap in that session (no pit stops, spins or wrecks)
 */
export function cleanLapsBySession(laps: PerfLap[]): Map<string, number[]> {
  const valid = new Map<string, PerfLap[]>()
  for (const lap of laps) {
    if (!lap.valid || lapOrNull(lap.lapMs) === null) continue
    const key = groupKey(lap.sessionId, lap.participantId)
    valid.set(key, [...(valid.get(key) ?? []), lap])
  }
  const clean = new Map<string, number[]>()
  for (const [key, group] of valid) {
    const best = Math.min(...group.map((l) => l.lapMs))
    clean.set(
      key,
      group.filter((l) => l.lapNumber > 1 && l.lapMs <= best * 1.07).map((l) => l.lapMs),
    )
  }
  return clean
}

/** Each driver's best valid lap per session (from laps; the results file's best lap when there are no laps) */
export function bestLapBySession(data: Pick<RaceData, "laps" | "results">): Map<string, number> {
  const best = new Map<string, number>()
  for (const lap of data.laps) {
    if (!lap.valid || lapOrNull(lap.lapMs) === null) continue
    const key = groupKey(lap.sessionId, lap.participantId)
    best.set(key, Math.min(best.get(key) ?? Infinity, lap.lapMs))
  }
  const withLaps = new Set(data.laps.map((l) => l.sessionId))
  for (const result of data.results) {
    const key = groupKey(result.sessionId, result.participantId)
    const stored = lapOrNull(result.bestLapMs)
    if (!best.has(key) && stored !== null && !withLaps.has(result.sessionId)) best.set(key, stored)
  }
  return best
}

/**
 * Positions gained in each race: qualifying position minus race position, for drivers in a
 * qualifying session of the same event (the event's first one), by sim driver id. The same rule as
 * Recompute standings. Keyed by session and participant
 */
export function positionsGained(data: Pick<RaceData, "sessions" | "results">): Map<string, { grid: number; gained: number }> {
  const qualifying = new Map<string, string>()
  for (const session of [...data.sessions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    if (session.type === "QUALIFYING" && session.event && !qualifying.has(session.event.id)) qualifying.set(session.event.id, session.id)
  }
  const qualifyingIds = new Set(qualifying.values())
  const gridBySession = new Map<string, Map<string, number>>()
  for (const result of data.results) {
    if (!qualifyingIds.has(result.sessionId)) continue
    const grid = gridBySession.get(result.sessionId) ?? new Map<string, number>()
    grid.set(result.driverGuid, result.position)
    gridBySession.set(result.sessionId, grid)
  }
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]))
  const gained = new Map<string, { grid: number; gained: number }>()
  for (const result of data.results) {
    const session = sessionById.get(result.sessionId)
    if (session?.type !== "RACE" || !session.event) continue
    const qualifyingId = qualifying.get(session.event.id)
    const grid = qualifyingId ? gridBySession.get(qualifyingId)?.get(result.driverGuid) : undefined
    if (grid !== undefined) gained.set(groupKey(result.sessionId, result.participantId), { grid, gained: grid - result.position })
  }
  return gained
}

/** Collisions per driver in a session, split by type */
function collisionsBySession(incidents: PerfIncident[]): Map<string, { cars: number; env: number }> {
  const out = new Map<string, { cars: number; env: number }>()
  for (const incident of incidents) {
    const key = groupKey(incident.sessionId, incident.participantId)
    const entry = out.get(key) ?? { cars: 0, env: 0 }
    if (incident.type === "COLLISION_WITH_CAR") entry.cars += incident.count
    else if (incident.type === "COLLISION_WITH_ENV") entry.env += incident.count
    out.set(key, entry)
  }
  return out
}

function fieldSizes(results: PerfResult[]): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const r of results) sizes.set(r.sessionId, (sizes.get(r.sessionId) ?? 0) + 1)
  return sizes
}

const average = (values: number[]) => (values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null)

export type DriverSummary = {
  driver: PerfDriver
  races: number
  wins: number
  podiums: number
  averageFinish: number | null
  bestFinish: number | null
  dsq: number
  points: number
  lapsCompleted: number
  /** Races with a qualifying result to compare against, and the positions gained over them */
  racesWithGrid: number
  positionsGained: number
  averageGained: number | null
  cuts: number
  /** Collisions as the results count them, and split by what was hit when the session's collision events were loaded */
  collisions: number
  collisionsWithCars: number
  collisionsWithEnv: number
  /** Cuts plus collisions, per race (the standings' "incidents") */
  incidentsPerRace: number | null
  /** Average lap-time spread (as a % of the average clean lap) over sessions with 5 or more clean laps; lower is steadier */
  consistencyPct: number | null
  cleanLaps: number
}

/** One row per driver over the race sessions in `data` (lap figures from `lapSessionTypes`) */
export function summarizeDrivers(data: RaceData, lapSessionTypes: string[] = ["RACE"]): DriverSummary[] {
  const sessionType = new Map(data.sessions.map((s) => [s.id, s.type]))
  const gained = positionsGained(data)
  const collisions = collisionsBySession(data.incidents)
  const clean = cleanLapsBySession(data.laps.filter((l) => lapSessionTypes.includes(sessionType.get(l.sessionId) ?? "")))
  const participantDriver = new Map(data.results.map((r) => [groupKey(r.sessionId, r.participantId), r.driver.key]))

  const rows = new Map<string, DriverSummary & { finishes: number[]; spreads: number[] }>()
  const rowOf = (driver: PerfDriver) => {
    let row = rows.get(driver.key)
    if (!row) {
      row = {
        driver,
        races: 0,
        wins: 0,
        podiums: 0,
        averageFinish: null,
        bestFinish: null,
        dsq: 0,
        points: 0,
        lapsCompleted: 0,
        racesWithGrid: 0,
        positionsGained: 0,
        averageGained: null,
        cuts: 0,
        collisions: 0,
        collisionsWithCars: 0,
        collisionsWithEnv: 0,
        incidentsPerRace: null,
        consistencyPct: null,
        cleanLaps: 0,
        finishes: [],
        spreads: [],
      }
      rows.set(driver.key, row)
    }
    return row
  }

  for (const result of data.results) {
    if (sessionType.get(result.sessionId) !== "RACE") continue
    const row = rowOf(result.driver)
    const key = groupKey(result.sessionId, result.participantId)
    row.races += 1
    row.finishes.push(result.position)
    if (result.position === 1) row.wins += 1
    if (result.position <= 3) row.podiums += 1
    if (result.dsq) row.dsq += 1
    row.points += result.points ?? 0
    row.lapsCompleted += result.laps
    row.cuts += result.cuts
    row.collisions += result.collisions
    const hit = collisions.get(key)
    if (hit) {
      row.collisionsWithCars += hit.cars
      row.collisionsWithEnv += hit.env
    }
    const grid = gained.get(key)
    if (grid) {
      row.racesWithGrid += 1
      row.positionsGained += grid.gained
    }
  }
  for (const [key, laps] of clean) {
    const driverKey = participantDriver.get(key)
    const row = driverKey ? rows.get(driverKey) : undefined
    if (!row) continue
    row.cleanLaps += laps.length
    const stats = laps.length >= 5 ? lapStats(laps) : null
    if (stats) row.spreads.push(stats.spreadPct)
  }

  return [...rows.values()]
    .map(({ finishes, spreads, ...row }) => ({
      ...row,
      averageFinish: average(finishes),
      bestFinish: finishes.length ? Math.min(...finishes) : null,
      averageGained: row.racesWithGrid ? round2(row.positionsGained / row.racesWithGrid) : null,
      incidentsPerRace: row.races ? round2((row.cuts + row.collisions) / row.races) : null,
      consistencyPct: average(spreads),
    }))
    .sort((a, b) => b.points - a.points || (a.averageFinish ?? 99) - (b.averageFinish ?? 99) || a.driver.name.localeCompare(b.driver.name))
}

export type TrackLapRow = {
  track: string
  driver: PerfDriver
  bestLapMs: number
  /** Average clean lap; null with no clean laps */
  averageLapMs: number | null
  cleanLaps: number
  spreadMs: number | null
  /** How far the driver's best is off the fastest lap at this track in `data`, in % */
  gapPct: number
  sessions: number
}

/** Best and average laps per track and driver, fastest first within each track */
export function lapsByTrack(data: RaceData, sessionTypes: string[] = ["RACE"]): TrackLapRow[] {
  const sessions = new Map(data.sessions.filter((s) => sessionTypes.includes(s.type)).map((s) => [s.id, s]))
  const scoped = { ...data, laps: data.laps.filter((l) => sessions.has(l.sessionId)), results: data.results.filter((r) => sessions.has(r.sessionId)) }
  const best = bestLapBySession(scoped)
  const clean = cleanLapsBySession(scoped.laps)

  const rows = new Map<string, { track: string; driver: PerfDriver; best: number; clean: number[]; sessions: Set<string> }>()
  for (const result of scoped.results) {
    const key = groupKey(result.sessionId, result.participantId)
    const lap = best.get(key)
    if (lap === undefined) continue
    const track = sessions.get(result.sessionId)!.track
    const rowKey = `${track}\u0000${result.driver.key}`
    const row = rows.get(rowKey) ?? { track, driver: result.driver, best: Infinity, clean: [], sessions: new Set<string>() }
    row.best = Math.min(row.best, lap)
    row.clean.push(...(clean.get(key) ?? []))
    row.sessions.add(result.sessionId)
    rows.set(rowKey, row)
  }
  const fastest = new Map<string, number>()
  for (const row of rows.values()) fastest.set(row.track, Math.min(fastest.get(row.track) ?? Infinity, row.best))
  return [...rows.values()]
    .map((row) => {
      const stats = lapStats(row.clean)
      return {
        track: row.track,
        driver: row.driver,
        bestLapMs: row.best,
        averageLapMs: stats?.meanMs ?? null,
        cleanLaps: row.clean.length,
        spreadMs: stats && stats.count > 1 ? stats.spreadMs : null,
        gapPct: round2(((row.best - fastest.get(row.track)!) / fastest.get(row.track)!) * 100),
        sessions: row.sessions.size,
      }
    })
    .sort((a, b) => a.track.localeCompare(b.track) || a.bestLapMs - b.bestLapMs)
}

export type RoundSummary = {
  event: { id: string; title: string; slug: string; startsAt: Date }
  track: string
  drivers: number
  winner: PerfDriver | null
  fastestLap: { driver: PerfDriver; lapMs: number } | null
  incidents: number
}

/** Each event's race: who won, the fastest race lap, the field and its incidents; oldest first */
export function summarizeRounds(data: RaceData): RoundSummary[] {
  const best = bestLapBySession(data)
  const out: RoundSummary[] = []
  const races = data.sessions.filter((s) => s.type === "RACE" && s.event).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  for (const session of races) {
    const results = data.results.filter((r) => r.sessionId === session.id)
    if (!results.length) continue
    let fastestLap: RoundSummary["fastestLap"] = null
    for (const r of results) {
      const lap = best.get(groupKey(r.sessionId, r.participantId))
      if (lap !== undefined && (!fastestLap || lap < fastestLap.lapMs)) fastestLap = { driver: r.driver, lapMs: lap }
    }
    out.push({
      event: session.event!,
      track: session.track,
      drivers: results.length,
      winner: results.find((r) => r.position === 1)?.driver ?? null,
      fastestLap,
      incidents: results.reduce((n, r) => n + r.cuts + r.collisions, 0),
    })
  }
  return out
}

export type TrendRow = {
  event: { title: string; slug: string; startsAt: Date } | null
  track: string
  date: Date
  position: number
  field: number
  points: number | null
  dsq: boolean
  laps: number
  bestLapMs: number | null
  /** % off the race's fastest lap */
  gapToFastestPct: number | null
  gained: number | null
  incidents: number
}

/** One driver's races in order, oldest first: finish, best lap against the race's fastest, positions gained, incidents */
export function driverTrend(data: RaceData, key: string): TrendRow[] {
  const sessions = new Map(data.sessions.map((s) => [s.id, s]))
  const best = bestLapBySession(data)
  const gained = positionsGained(data)
  const fields = fieldSizes(data.results)
  const fastest = new Map<string, number>()
  for (const r of data.results) {
    const lap = best.get(groupKey(r.sessionId, r.participantId))
    if (lap !== undefined) fastest.set(r.sessionId, Math.min(fastest.get(r.sessionId) ?? Infinity, lap))
  }
  return data.results
    .filter((r) => r.driver.key === key && sessions.get(r.sessionId)?.type === "RACE")
    .map((r) => {
      const session = sessions.get(r.sessionId)!
      const lap = best.get(groupKey(r.sessionId, r.participantId)) ?? null
      const top = fastest.get(r.sessionId)
      return {
        event: session.event ? { title: session.event.title, slug: session.event.slug, startsAt: session.event.startsAt } : null,
        track: session.track,
        date: session.startedAt,
        position: r.position,
        field: fields.get(r.sessionId) ?? 0,
        points: r.points,
        dsq: r.dsq,
        laps: r.laps,
        bestLapMs: lap,
        gapToFastestPct: lap !== null && top ? round2(((lap - top) / top) * 100) : null,
        gained: gained.get(groupKey(r.sessionId, r.participantId))?.gained ?? null,
        incidents: r.cuts + r.collisions,
      }
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime())
}

/** Average finish in the earlier and later half of a trend, and whether it improved (a lower finish is better) */
export function trendDirection(rows: Pick<TrendRow, "position">[]): { earlier: number | null; later: number | null; direction: "improving" | "worsening" | "steady" | "too few races" } {
  if (rows.length < 4) return { earlier: null, later: null, direction: "too few races" }
  const half = Math.floor(rows.length / 2)
  const earlier = average(rows.slice(0, half).map((r) => r.position))!
  const later = average(rows.slice(rows.length - half).map((r) => r.position))!
  const change = later - earlier
  return { earlier, later, direction: Math.abs(change) < 0.5 ? "steady" : change < 0 ? "improving" : "worsening" }
}

export type HeadToHeadRace = {
  title: string
  date: Date
  type: string
  a: { position: number; bestLapMs: number | null }
  b: { position: number; bestLapMs: number | null }
}

export type HeadToHead = {
  races: number
  aAhead: number
  bAhead: number
  qualifying: number
  aAheadInQualifying: number
  bAheadInQualifying: number
  /** Average of a's best lap minus b's in sessions where both set one, in ms (negative: a was quicker) */
  averageLapGapMs: number | null
  sessions: HeadToHeadRace[]
}

/** Two drivers in the races and qualifying sessions they both drove */
export function headToHead(data: RaceData, aKey: string, bKey: string): HeadToHead {
  const best = bestLapBySession(data)
  const sessions = [...data.sessions].filter((s) => s.type === "RACE" || s.type === "QUALIFYING").sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())
  const out: HeadToHead = { races: 0, aAhead: 0, bAhead: 0, qualifying: 0, aAheadInQualifying: 0, bAheadInQualifying: 0, averageLapGapMs: null, sessions: [] }
  const gaps: number[] = []
  for (const session of sessions) {
    const a = data.results.find((r) => r.sessionId === session.id && r.driver.key === aKey)
    const b = data.results.find((r) => r.sessionId === session.id && r.driver.key === bKey)
    if (!a || !b) continue
    const aLap = best.get(groupKey(a.sessionId, a.participantId)) ?? null
    const bLap = best.get(groupKey(b.sessionId, b.participantId)) ?? null
    if (aLap !== null && bLap !== null) gaps.push(aLap - bLap)
    if (session.type === "RACE") {
      out.races += 1
      if (a.position < b.position) out.aAhead += 1
      else out.bAhead += 1
    } else {
      out.qualifying += 1
      if (a.position < b.position) out.aAheadInQualifying += 1
      else out.bAheadInQualifying += 1
    }
    out.sessions.push({
      title: session.event?.title ?? session.track,
      date: session.startedAt,
      type: session.type,
      a: { position: a.position, bestLapMs: aLap },
      b: { position: b.position, bestLapMs: bLap },
    })
  }
  out.averageLapGapMs = gaps.length ? Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length) : null
  return out
}
