import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import {
  driverTrend,
  formatLap,
  headToHead,
  lapsByTrack,
  RACE_DATA_LIMITS,
  summarizeDrivers,
  summarizeRounds,
  trendDirection,
  type DriverSummary,
  type PerfDriver,
  type RaceData,
} from "@/lib/race-performance"
import { prisma } from "@/server/db"
import { loadRaceData } from "@/server/queries/race-performance"
import { forModelWithLists, plural, tableDisplay, type ModelList } from "./display"
import { DEFAULT_LEAGUE, resolveLeagueSeason } from "./seasons"
import { ct, ctShort } from "./time"
import type { JackTool, JackToolResult } from "./types"

/**
 * race_performance (#188, design §7.1): how drivers did, from the uploaded result files: best and
 * average laps by driver, track and round, consistency, incidents, positions gained, a driver's trend
 * over a season and head-to-heads. Every result states the data's limits (no DNF, classPosition 0).
 */

const FOCUS = ["overview", "laps", "incidents", "positions", "rounds", "trend", "head_to_head"] as const
const SESSIONS = { race: ["RACE"], qualifying: ["QUALIFYING"], practice: ["PRACTICE"], all: ["RACE", "QUALIFYING", "PRACTICE"] } as const

const input = z.object({
  season: z.string().trim().max(80).optional().describe('Season slug, e.g. lone-star-cup-s3 (default: the open season, else the latest), or "all" for every uploaded session'),
  league: z.string().trim().max(80).default(DEFAULT_LEAGUE).describe("League slug"),
  focus: z
    .enum(FOCUS)
    .default("overview")
    .describe(
      "overview: per driver finishes, points, positions gained, incidents and consistency. laps: best and average clean laps by track and driver. incidents: cuts and collisions per driver and round. positions: qualifying vs race positions. rounds: each round's winner and fastest lap. trend: one driver's races in order. head_to_head: two drivers in the sessions they shared",
    ),
  drivers: z.array(z.string().trim().min(1).max(80)).max(6).optional().describe("Handles or names. trend needs one, head_to_head exactly two; other views show only these drivers"),
  track: z.string().trim().min(1).max(80).optional().describe("Only tracks whose sim name contains this, e.g. monza"),
  round: z.string().trim().min(1).max(120).optional().describe("Only events whose title or slug contains this, e.g. Round 3"),
  sessions: z.enum(["race", "qualifying", "practice", "all"]).default("race").describe("Which sessions lap times come from. Finishes, points and incidents always come from races"),
  limit: z.number().int().min(1).max(100).default(40).describe("Most rows per list"),
})

type Input = z.infer<typeof input>

/** The drivers named in a call, from everyone in the data: exact handle or name, then a unique part of a name or handle */
export function matchDrivers(asked: string[], drivers: PerfDriver[]): { ok: true; keys: string[] } | { ok: false; error: string } {
  const unique = [...new Map(drivers.map((d) => [d.key, d])).values()]
  const names = (list: PerfDriver[]) => list.slice(0, 30).map((d) => (d.handle ? `${d.name} (@${d.handle})` : d.name)).join(", ")
  const keys: string[] = []
  for (const raw of asked) {
    const wanted = raw.trim().replace(/^@/, "").toLowerCase()
    const exact = unique.filter((d) => d.handle?.toLowerCase() === wanted || d.name.toLowerCase() === wanted)
    const found = exact.length ? exact : unique.filter((d) => d.name.toLowerCase().includes(wanted) || d.handle?.toLowerCase().includes(wanted))
    if (found.length !== 1) {
      return {
        ok: false,
        error: found.length ? `"${raw}" matches several drivers: ${names(found)}. Use a handle.` : `No driver matching "${raw}" in these results. Drivers: ${names(unique) || "none"}.`,
      }
    }
    keys.push(found[0].key)
  }
  return { ok: true, keys: [...new Set(keys)] }
}

/** Keeps only the sessions that pass a filter, with their rows */
export function filterSessions(data: RaceData, keep: (session: RaceData["sessions"][number]) => boolean): RaceData {
  const sessions = data.sessions.filter(keep)
  const ids = new Set(sessions.map((s) => s.id))
  return { sessions, results: data.results.filter((r) => ids.has(r.sessionId)), laps: data.laps.filter((l) => ids.has(l.sessionId)), incidents: data.incidents.filter((i) => ids.has(i.sessionId)) }
}

const who = (d: PerfDriver) => (d.handle ? `${d.name} (@${d.handle})` : `${d.name} (not linked to a member)`)
const seconds = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toFixed(3)} s`)
const failed = (forModel: string): JackToolResult => ({ isError: true, forModel, label: "Race performance lookup failed", displays: [] })

/** The sessions a call is about: a season's rounds (its series' events between its dates, as the standings count them) or everything */
async function scopeOf({ season, league }: Pick<Input, "season" | "league">, now: Date): Promise<{ ok: true; label: string; eventIds?: string[] } | { ok: false; error: string }> {
  if (season?.toLowerCase() === "all") return { ok: true, label: "every uploaded session" }
  const resolved = await resolveLeagueSeason(league, season, now)
  if (!resolved.ok) return resolved
  const { season: found } = resolved
  if (!found.seriesId) return { ok: false, error: `${found.name} has no event series, so its rounds aren't linked. Ask with season "all" and a round or track instead.` }
  const events = await prisma.event.findMany({
    where: { seriesId: found.seriesId, startsAtUtc: { gte: found.startAt ?? undefined, lte: found.endAt ?? undefined } },
    select: { id: true },
  })
  return { ok: true, label: found.name, eventIds: events.map((e) => e.id) }
}

function driverRow(d: DriverSummary) {
  return {
    driver: who(d.driver),
    races: d.races,
    wins: d.wins,
    podiums: d.podiums,
    averageFinish: d.averageFinish,
    bestFinish: d.bestFinish,
    points: d.points,
    ...(d.dsq ? { dsq: d.dsq } : {}),
    lapsCompleted: d.lapsCompleted,
    positionsGained: d.racesWithGrid ? { total: d.positionsGained, perRace: d.averageGained, racesWithQualifying: d.racesWithGrid } : null,
    incidents: { cuts: d.cuts, collisions: d.collisions, withCars: d.collisionsWithCars, withWalls: d.collisionsWithEnv, perRace: d.incidentsPerRace },
    lapSpreadPct: d.consistencyPct,
  }
}

export const racePerformanceTool: JackTool<Input> = {
  name: "race_performance",
  description:
    "Driving analysis from uploaded race results (Lone Star Cup by default): best and average clean laps by driver, track and round; consistency (lap-time spread, lower is steadier); incidents (cuts, collisions with cars and walls); positions gained from qualifying to the finish; each round's winner and fastest lap; one driver's trend over a season; two drivers head to head. Use standings for the points table. Every result states the data's limits: no DNF is recorded and classPosition is always 0.",
  input,
  deferred: true,
  async run(args) {
    const now = new Date()
    const scope = await scopeOf(args, now)
    if (!scope.ok) return failed(scope.error)

    let data = await loadRaceData({ eventIds: scope.eventIds, withLaps: true, withIncidents: true }, now)
    const trackFilter = args.track?.toLowerCase()
    const roundFilter = args.round?.toLowerCase()
    if (trackFilter) data = filterSessions(data, (s) => s.track.toLowerCase().includes(trackFilter))
    if (roundFilter) data = filterSessions(data, (s) => Boolean(s.event && (s.event.title.toLowerCase().includes(roundFilter) || s.event.slug.toLowerCase().includes(roundFilter))))

    const races = data.sessions.filter((s) => s.type === "RACE")
    const base: Record<string, unknown> = {
      scope: scope.label,
      ...(args.track ? { track: args.track } : {}),
      ...(args.round ? { round: args.round } : {}),
      sessions: { races: races.length, qualifying: data.sessions.filter((s) => s.type === "QUALIFYING").length, practice: data.sessions.filter((s) => s.type === "PRACTICE").length },
      dataLimits: RACE_DATA_LIMITS,
    }
    if (!data.sessions.length) {
      return {
        forModel: forModelWithLists({ ...base, note: 'No uploaded sessions match. Try season "all", or another track or round.' }, []),
        label: `Looked at race performance (${scope.label}: no sessions)`,
        displays: [{ kind: "note", text: "No uploaded sessions match." }],
      }
    }

    let only: Set<string> | null = null
    if (args.drivers?.length) {
      const matched = matchDrivers(args.drivers, data.results.map((r) => r.driver))
      if (!matched.ok) return failed(matched.error)
      only = new Set(matched.keys)
    }
    const picked = (driver: PerfDriver) => !only || only.has(driver.key)
    const lapTypes: string[] = [...SESSIONS[args.sessions]]
    const lists: ModelList[] = []
    const displays: JackToolDisplay[] = []
    /** A list capped at `limit`, saying how many there were in all when some were left out */
    const list = <T>(key: string, items: T[], keep: "first" | "last" = "first", whenTrimmed?: string) => {
      const kept = items.length > args.limit ? (keep === "last" ? items.slice(-args.limit) : items.slice(0, args.limit)) : items
      if (kept.length < items.length) base[`${key}Total`] = items.length
      lists.push({ key, items: kept, keep, whenTrimmed })
      return kept
    }
    let label = `Looked at race performance (${scope.label}, ${plural(races.length, "race")})`

    if (args.focus === "overview" || args.focus === "incidents" || args.focus === "positions") {
      const drivers = summarizeDrivers(data, lapTypes).filter((d) => picked(d.driver))
      const ordered =
        args.focus === "incidents"
          ? [...drivers].sort((a, b) => (b.incidentsPerRace ?? 0) - (a.incidentsPerRace ?? 0))
          : args.focus === "positions"
            ? drivers.filter((d) => d.racesWithGrid).sort((a, b) => b.positionsGained - a.positionsGained)
            : drivers
      list("drivers", ordered.map(driverRow))
      const shown = ordered.slice(0, args.limit)
      if (args.focus === "incidents") list("rounds", summarizeRounds(data).map((r) => ({ round: r.event.title, date: ct(r.event.startsAt), drivers: r.drivers, incidents: r.incidents })))
      if (!shown.length) displays.push({ kind: "note", text: args.focus === "positions" ? "No races with a qualifying session to compare against." : "No race results match." })
      else if (args.focus === "incidents")
        displays.push(
          tableDisplay(shown, [
            { header: "Driver", value: (d) => d.driver.name },
            { header: "Races", value: (d) => d.races },
            { header: "Cuts", value: (d) => d.cuts },
            { header: "Collisions", value: (d) => d.collisions },
            { header: "Per race", value: (d) => d.incidentsPerRace },
          ]),
        )
      else if (args.focus === "positions")
        displays.push(
          tableDisplay(shown, [
            { header: "Driver", value: (d) => d.driver.name },
            { header: "Races with qualifying", value: (d) => d.racesWithGrid },
            { header: "Gained", value: (d) => d.positionsGained },
            { header: "Per race", value: (d) => d.averageGained },
          ]),
        )
      else
        displays.push(
          tableDisplay(
            shown,
            [
              { header: "Driver", value: (d) => d.driver.name },
              { header: "Races", value: (d) => d.races },
              { header: "Wins", value: (d) => d.wins },
              { header: "Avg finish", value: (d) => d.averageFinish },
              { header: "Gained", value: (d) => (d.racesWithGrid ? d.positionsGained : null) },
              { header: "Incidents/race", value: (d) => d.incidentsPerRace },
              { header: "Lap spread %", value: (d) => d.consistencyPct },
            ],
            scope.label,
          ),
        )
    } else if (args.focus === "laps") {
      const rows = lapsByTrack(data, lapTypes).filter((r) => picked(r.driver))
      const shown = list(
        "laps",
        rows.map((r) => ({
          track: r.track,
          driver: who(r.driver),
          bestLap: formatLap(r.bestLapMs),
          averageCleanLap: formatLap(r.averageLapMs),
          cleanLaps: r.cleanLaps,
          spread: seconds(r.spreadMs),
          offTrackBestPct: r.gapPct,
          sessions: r.sessions,
        })),
        "first",
        "Name a track or drivers to see the rest.",
      )
      displays.push(
        shown.length
          ? tableDisplay(rows.slice(0, shown.length), [
              { header: "Track", value: (r) => r.track },
              { header: "Driver", value: (r) => r.driver.name },
              { header: "Best lap", value: (r) => formatLap(r.bestLapMs) },
              { header: "Avg clean lap", value: (r) => formatLap(r.averageLapMs) },
              { header: "Off best %", value: (r) => r.gapPct },
            ])
          : { kind: "note", text: "No lap times match." },
      )
      label = `Looked at lap times (${scope.label}, ${plural(new Set(rows.map((r) => r.track)).size, "track")})`
    } else if (args.focus === "rounds") {
      const rounds = summarizeRounds(data)
      list(
        "rounds",
        rounds.map((r) => ({
          round: r.event.title,
          date: ct(r.event.startsAt),
          track: r.track,
          drivers: r.drivers,
          winner: r.winner ? who(r.winner) : null,
          fastestLap: r.fastestLap ? { driver: who(r.fastestLap.driver), lap: formatLap(r.fastestLap.lapMs) } : null,
          incidents: r.incidents,
        })),
      )
      displays.push(
        rounds.length
          ? tableDisplay(rounds, [
              { header: "Round", value: (r) => r.event.title },
              { header: "Date (CT)", value: (r) => ctShort(r.event.startsAt) },
              { header: "Winner", value: (r) => r.winner?.name ?? null },
              { header: "Fastest lap", value: (r) => (r.fastestLap ? `${formatLap(r.fastestLap.lapMs)} ${r.fastestLap.driver.name}` : null) },
            ])
          : { kind: "note", text: "No races with results match." },
      )
    } else if (args.focus === "trend") {
      if (only?.size !== 1) return failed("trend needs exactly one driver in drivers.")
      const key = [...only][0]
      const driver = data.results.find((r) => r.driver.key === key)!.driver
      const rows = driverTrend(data, key)
      const direction = trendDirection(rows)
      base.driver = who(driver)
      base.direction = { ...direction, note: "Average finish in the earlier and later half of these races; lower is better." }
      list(
        "races",
        rows.map((r) => ({
          round: r.event?.title ?? r.track,
          date: ct(r.date),
          track: r.track,
          finish: `P${r.position} of ${r.field}`,
          ...(r.dsq ? { dsq: true } : {}),
          laps: r.laps,
          points: r.points,
          bestLap: formatLap(r.bestLapMs),
          offFastestLapPct: r.gapToFastestPct,
          positionsGained: r.gained,
          incidents: r.incidents,
        })),
        "last",
      )
      displays.push(
        rows.length
          ? tableDisplay(
              rows,
              [
                { header: "Round", value: (r) => r.event?.title ?? r.track },
                { header: "Finish", value: (r) => `P${r.position}/${r.field}` },
                { header: "Best lap", value: (r) => formatLap(r.bestLapMs) },
                { header: "Off fastest %", value: (r) => r.gapToFastestPct },
                { header: "Gained", value: (r) => r.gained },
              ],
              driver.name,
            )
          : { kind: "note", text: `${driver.name} has no race results here.` },
      )
      label = `Looked at ${driver.name}'s results (${plural(rows.length, "race")}, ${direction.direction})`
    } else {
      if (only?.size !== 2) return failed("head_to_head needs exactly two drivers in drivers.")
      const [aKey, bKey] = [...only]
      const a = data.results.find((r) => r.driver.key === aKey)!.driver
      const b = data.results.find((r) => r.driver.key === bKey)!.driver
      const h2h = headToHead(data, aKey, bKey)
      base.drivers = [who(a), who(b)]
      base.summary = {
        racesTogether: h2h.races,
        finishedAhead: { [a.name]: h2h.aAhead, [b.name]: h2h.bAhead },
        qualifyingTogether: h2h.qualifying,
        qualifiedAhead: { [a.name]: h2h.aAheadInQualifying, [b.name]: h2h.bAheadInQualifying },
        averageBestLapGap: h2h.averageLapGapMs === null ? null : `${a.name} ${h2h.averageLapGapMs <= 0 ? "quicker" : "slower"} by ${seconds(Math.abs(h2h.averageLapGapMs))} on average, in the sessions both set a lap`,
      }
      list(
        "sessions",
        h2h.sessions.map((s) => ({
          session: `${s.title} (${s.type.toLowerCase()})`,
          date: ct(s.date),
          [a.name]: { position: s.a.position, bestLap: formatLap(s.a.bestLapMs) },
          [b.name]: { position: s.b.position, bestLap: formatLap(s.b.bestLapMs) },
        })),
        "last",
      )
      displays.push({
        kind: "stats",
        items: [
          { label: `${a.name} ahead`, value: h2h.aAhead, hint: `of ${plural(h2h.races, "race")}` },
          { label: `${b.name} ahead`, value: h2h.bAhead, hint: `of ${plural(h2h.races, "race")}` },
          { label: "Qualifying", value: `${h2h.aAheadInQualifying}–${h2h.bAheadInQualifying}`, hint: plural(h2h.qualifying, "session") },
        ],
      })
      if (h2h.sessions.length)
        displays.push(
          tableDisplay(h2h.sessions, [
            { header: "Session", value: (s) => `${s.title} (${s.type.toLowerCase()})` },
            { header: a.name, value: (s) => `P${s.a.position} · ${formatLap(s.a.bestLapMs) ?? "no lap"}` },
            { header: b.name, value: (s) => `P${s.b.position} · ${formatLap(s.b.bestLapMs) ?? "no lap"}` },
          ]),
        )
      label = `Compared ${a.name} and ${b.name} (${plural(h2h.races, "race")} together)`
    }

    return { forModel: forModelWithLists(base, lists), label, displays }
  },
}
