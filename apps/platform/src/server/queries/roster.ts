import { EventStatus } from "@prisma/client"
import { prisma } from "@/server/db"
import { publicUserSelect } from "@/lib/public-user"
import { publicEventWhere } from "@/lib/events"
import { getActiveTierKey } from "@/lib/status-indicators"
import { pickRacingNumberStyle, type RacingNumberStyle } from "@/lib/racing-number"
import { byName } from "@/app/drivers/names"

const LSC_LEAGUE_SLUG = "lone-star-cup"
const PUBLIC_TIERS = ["ALUMNI", "PARTNER"]

/** One row of the public roster. Everything here ends up in the page's HTML, so public fields only. */
export type RosterDriver = RacingNumberStyle & {
  id: string
  handle: string
  displayName: string
  avatarUrl: string | null
  pending: boolean
  officerTitle: string | null
  /** Display roles only: admins show as "officer", so who has full access stays private */
  roles: string[]
  /** "ALUMNI" or "PARTNER", the only tiers with a public badge; null otherwise, so dues stay private */
  tierKey: string | null
  /** Raced (or entered) the Lone Star Cup */
  lsc: boolean
  points: number
  /** All-time position; null until the driver scores */
  rank: number | null
  seasons: number
  starts: number
  wins: number
  podiums: number
  bestFinish: number | null
  /** Lone Star Cup titles, e.g. ["S2"] */
  titles: string[]
}

/** "Lone Star Cup | Season 2" → "S2" */
function shortSeason(name: string) {
  const number = name.match(/\bSeason\s+(\d+)/i)?.[1]
  return number ? `S${number}` : name.split("|").pop()!.trim()
}

/** Every driver with all-time totals from their season entries, ranked by points. */
async function getRosterDrivers(now: Date): Promise<RosterDriver[]> {
  const [users, entries, lscSeasons] = await Promise.all([
    prisma.user.findMany({
      where: { status: { not: "deleted" } },
      select: {
        ...publicUserSelect,
        status: true,
        officerTitle: true,
        roles: { select: { role: { select: { key: true } } } },
        memberships: { select: { validTo: true, tier: { select: { key: true } } } },
      },
    }),
    prisma.entry.findMany({
      where: { userId: { not: null }, season: { visibility: "public" } },
      select: {
        userId: true,
        totalPoints: true,
        starts: true,
        wins: true,
        podiums: true,
        bestFinish: true,
        season: { select: { league: { select: { slug: true } } } },
      },
    }),
    prisma.season.findMany({
      // Same seasons as /lone-star-cup, so both pages agree on which one is current
      where: { visibility: "public", league: { slug: LSC_LEAGUE_SLUG }, seriesId: { not: null } },
      orderBy: [{ startAt: { sort: "desc", nulls: "last" } }, { year: "desc" }],
      select: {
        name: true,
        endAt: true,
        entries: {
          where: { totalPoints: { gt: 0 } },
          orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { totalPoints: "desc" }],
          take: 1,
          select: { userId: true },
        },
      },
    }),
  ])

  // A season's champion is its leader once the season is over: any season but the newest, or the
  // newest after its end date. A champion whose account is gone keeps the title (nobody inherits it)
  const titles = new Map<string, string[]>()
  lscSeasons.forEach((season, i) => {
    const over = i > 0 || (!!season.endAt && season.endAt < now)
    const championId = season.entries[0]?.userId
    if (over && championId) titles.set(championId, [...(titles.get(championId) ?? []), shortSeason(season.name)])
  })

  const totals = new Map<string, { points: number; seasons: number; starts: number; wins: number; podiums: number; bestFinish: number | null; lsc: boolean }>()
  for (const entry of entries) {
    const total = totals.get(entry.userId!) ?? { points: 0, seasons: 0, starts: 0, wins: 0, podiums: 0, bestFinish: null, lsc: false }
    total.points += entry.totalPoints
    total.starts += entry.starts
    total.wins += entry.wins
    total.podiums += entry.podiums
    if (entry.starts > 0) total.seasons += 1
    if (entry.bestFinish != null) total.bestFinish = Math.min(total.bestFinish ?? Infinity, entry.bestFinish)
    if (entry.season.league?.slug === LSC_LEAGUE_SLUG) total.lsc = true
    totals.set(entry.userId!, total)
  }

  const drivers = users.map((user) => {
    const total = totals.get(user.id)
    const keys = user.roles.map((r) => r.role.key)
    const roles = [
      ...(keys.includes("officer") || keys.includes("admin") ? ["officer"] : []),
      ...keys.filter((key) => key === "lsc_driver" || key === "collegiate_driver"),
    ]
    const tierKey = getActiveTierKey(user.memberships)
    return {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      ...pickRacingNumberStyle(user),
      pending: user.status === "pending_verification",
      officerTitle: user.officerTitle,
      roles,
      tierKey: tierKey && PUBLIC_TIERS.includes(tierKey) ? tierKey : null,
      lsc: !!total?.lsc || roles.includes("lsc_driver"),
      points: total?.points ?? 0,
      rank: null as number | null,
      seasons: total?.seasons ?? 0,
      starts: total?.starts ?? 0,
      wins: total?.wins ?? 0,
      podiums: total?.podiums ?? 0,
      bestFinish: total?.bestFinish ?? null,
      titles: titles.get(user.id) ?? [],
    }
  })

  // Points first; wins, then podiums, then name break ties
  drivers.sort(
    (a, b) =>
      b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || byName(a.displayName, b.displayName),
  )
  let rank = 0
  for (const driver of drivers) {
    if (driver.points > 0) driver.rank = ++rank
  }
  return drivers
}

/** The newest race with results, with its top three. */
async function getLatestResult() {
  return prisma.event.findFirst({
    where: {
      ...publicEventWhere(),
      ingestedSessions: { some: { sessionType: "RACE", results: { some: {} } } },
    },
    orderBy: { startsAtUtc: "desc" },
    select: {
      slug: true,
      title: true,
      startsAtUtc: true,
      timezone: true,
      heroImageUrl: true,
      series: { select: { title: true, slug: true } },
      ingestedSessions: {
        where: { sessionType: "RACE", results: { some: {} } },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: {
          results: {
            orderBy: { position: "asc" },
            take: 3,
            select: {
              id: true,
              points: true,
              participant: { select: { displayName: true, user: { select: publicUserSelect } } },
            },
          },
        },
      },
    },
  })
}

/** The next Lone Star Cup round. */
async function getNextRace(now: Date) {
  return prisma.event.findFirst({
    where: {
      AND: [publicEventWhere(now), { status: { notIn: [EventStatus.CANCELLED, EventStatus.POSTPONED] } }],
      startsAtUtc: { gt: now },
      series: { slug: { contains: LSC_LEAGUE_SLUG } },
    },
    orderBy: { startsAtUtc: "asc" },
    select: {
      slug: true,
      title: true,
      startsAtUtc: true,
      timezone: true,
      heroImageUrl: true,
      series: { select: { title: true, slug: true } },
    },
  })
}

/** Rounds with uploaded race results. */
function countScoredRaces() {
  return prisma.event.count({
    where: {
      ...publicEventWhere(),
      ingestedSessions: { some: { sessionType: "RACE", results: { some: {} } } },
    },
  })
}

export async function getRoster() {
  const now = new Date()
  const [drivers, latestResult, nextRace, scoredRaces] = await Promise.all([
    getRosterDrivers(now),
    getLatestResult(),
    getNextRace(now),
    countScoredRaces(),
  ])
  return { drivers, latestResult, nextRace, scoredRaces }
}

export type Roster = Awaited<ReturnType<typeof getRoster>>
