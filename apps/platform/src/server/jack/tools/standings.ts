import type { Prisma } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/server/db"
import { getStandings } from "@/server/repos/standings.repo"
import { forModelWithList, tableDisplay } from "./display"
import { DEFAULT_LEAGUE, resolveLeagueSeason } from "./seasons"
import { ct, ctShort } from "./time"
import type { JackTool } from "./types"

/**
 * standings: a season's standings as the site shows them (the Entry totals "Recompute standings"
 * writes), plus its rounds and which have results (#161). Rounds are the season's series events
 * between its start and end, the same set the recompute reads.
 */

/**
 * Counts an event's race results the way "Recompute standings" does: only RACE sessions with results
 * count (practice and qualifying alone don't put a round's results in). For a Prisma `_count` select.
 */
export const raceSessionsCount = { where: { sessionType: "RACE", results: { some: {} } } } satisfies { where: Prisma.RaceSessionWhereInput }

/** `ingestedSessions` here is the race sessions with results (raceSessionsCount), not every session */
export function roundResults(
  round: { startsAtUtc: Date; _count: { rawResultUploads: number; ingestedSessions: number } },
  now = new Date(),
): "results in" | "uploaded, no race results" | "no results yet" | "upcoming" {
  if (round._count.ingestedSessions > 0) return "results in"
  if (round._count.rawResultUploads > 0) return "uploaded, no race results"
  return round.startsAtUtc < now ? "no results yet" : "upcoming"
}

const input = z.object({
  season: z.string().max(80).optional().describe("Season slug, e.g. lone-star-cup-s3 (default: the open season, else the latest)"),
  league: z.string().max(80).default(DEFAULT_LEAGUE).describe("League slug"),
  limit: z.number().int().min(1).max(100).default(30).describe("How many drivers to return, from the top"),
})

export const standingsTool: JackTool<z.infer<typeof input>> = {
  name: "standings",
  description:
    "A league season's driver standings (rank, points, wins, podiums, starts, best finish, incidents, car) as the site shows them, plus the season's rounds with their dates and whether race results are in (as the standings count them), uploaded without race results yet, or missing. Standings only change when an officer clicks Recompute standings; the result says when that last happened.",
  input,
  async run({ season: seasonSlug, league: leagueSlug, limit }) {
    const now = new Date()
    const resolved = await resolveLeagueSeason(leagueSlug, seasonSlug, now)
    if (!resolved.ok) return { isError: true, forModel: resolved.error, label: "Standings lookup failed", displays: [] }
    const { season, seasons } = resolved

    const [standings, rounds, recompute] = await Promise.all([
      getStandings(season.slug),
      season.seriesId
        ? prisma.event.findMany({
            where: { seriesId: season.seriesId, startsAtUtc: { gte: season.startAt ?? undefined, lte: season.endAt ?? undefined } },
            orderBy: { startsAtUtc: "asc" },
            select: { title: true, startsAtUtc: true, status: true, _count: { select: { rawResultUploads: true, ingestedSessions: raceSessionsCount } } },
          })
        : Promise.resolve([]),
      prisma.auditLog.findFirst({
        where: { entityType: "SEASON", entityId: season.id, summary: { startsWith: "Recomputed standings" } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ])

    const top = standings.slice(0, limit).map((s, i) => ({
      rank: s.rank ?? i + 1,
      driver: s.driver.name,
      handle: s.driver.handle || null,
      points: s.points,
      wins: s.wins,
      podiums: s.podiums,
      starts: s.starts,
      bestFinish: s.bestFinish,
      incidents: s.incidents,
      positionsGained: s.positionsGained,
      car: s.car,
    }))
    const roundRows = rounds.map((r) => ({ round: r.title, startsAt: ct(r.startsAtUtc), status: r.status, results: roundResults(r, now) }))

    const result = {
      season: { slug: season.slug, name: season.name, startsAt: ct(season.startAt), endsAt: ct(season.endAt) },
      otherSeasons: seasons.filter((s) => s !== season.slug),
      standingsLastRecomputed: ct(recompute?.createdAt) ?? "never (or before the audit log)",
      drivers: standings.length,
      standings: top,
      rounds: season.seriesId ? roundRows : "This season has no event series, so its rounds aren't linked.",
    }

    return {
      forModel: forModelWithList(result, "standings", top),
      label: `Looked up ${season.name} standings (${standings.length} drivers, ${roundRows.filter((r) => r.results === "results in").length} of ${roundRows.length} rounds with results)`,
      displays: [
        standings.length
          ? tableDisplay(
              top,
              [
                { header: "#", value: (s) => s.rank },
                { header: "Driver", value: (s) => s.driver },
                { header: "Points", value: (s) => s.points },
                { header: "Wins", value: (s) => s.wins },
                { header: "Podiums", value: (s) => s.podiums },
                { header: "Starts", value: (s) => s.starts },
              ],
              season.name,
            )
          : { kind: "note", text: `No standings yet for ${season.name}.` },
        ...(rounds.length
          ? [
              tableDisplay(
                rounds,
                [
                  { header: "Round", value: (r) => r.title },
                  { header: "Date (CT)", value: (r) => ctShort(r.startsAtUtc) },
                  { header: "Results", value: (r) => roundResults(r, now) },
                ],
                "Rounds",
              ),
            ]
          : []),
      ],
    }
  },
}
