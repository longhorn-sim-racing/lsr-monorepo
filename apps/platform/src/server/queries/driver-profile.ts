import { cache } from "react"
import { prisma } from "@/server/db"
import { publicEventWhere } from "@/lib/events"
import { seasonLabel } from "@/lib/seasons"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { getRosterDrivers } from "@/server/queries/roster"
import { roundOf } from "@/server/queries/schedule"

/**
 * Everything on a driver's public page. Career numbers come from the same roster calculation as
 * /drivers (public seasons only), so the two pages always agree; the race list and cars come from
 * uploaded results, and only for public events.
 */
export const getDriverProfile = cache(async (handle: string) => {
  const now = new Date()
  const user = await prisma.user.findUnique({
    where: { handle },
    select: {
      id: true,
      handle: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      major: true,
      gradYear: true,
      iRating: true,
      socials: true,
      signedUpAt: true,
      status: true,
      racingNumber: true,
      racingNumberColor: true,
      racingNumberFont: true,
      racingNumberItalic: true,
      racingNumberBorder: true,
    },
  })
  if (!user || user.status === "deleted") return null

  const [roster, entries, results, attended] = await Promise.all([
    getRosterDrivers(now),
    prisma.entry.findMany({
      where: { userId: user.id, season: { visibility: "public" } },
      select: {
        totalPoints: true,
        rank: true,
        starts: true,
        wins: true,
        podiums: true,
        bestFinish: true,
        carDisplay: true,
        season: { select: { name: true, slug: true, startAt: true, year: true, league: { select: { name: true, slug: true } }, _count: { select: { entries: true } } } },
      },
    }),
    prisma.raceResult.findMany({
      where: {
        participant: { userId: user.id },
        session: { sessionType: "RACE", event: publicEventWhere(now) },
      },
      select: {
        id: true,
        position: true,
        points: true,
        bestLapTime: true,
        lapsCompleted: true,
        status: true,
        participant: { select: { carName: true, carMapping: { select: { displayName: true } } } },
        session: {
          select: {
            startedAt: true,
            trackName: true,
            _count: { select: { results: true } },
            event: { select: { slug: true, title: true, startsAtUtc: true, timezone: true, series: { select: { title: true, slug: true } } } },
          },
        },
      },
    }),
    prisma.eventAttendance.findMany({
      where: { userId: user.id, event: publicEventWhere(now) },
      orderBy: { event: { startsAtUtc: "desc" } },
      select: { event: { select: { slug: true, title: true, startsAtUtc: true, timezone: true, series: { select: { title: true } } } } },
    }),
  ])

  const driver = roster.find((d) => d.id === user.id) ?? null

  const seasons = entries
    .sort((a, b) => (b.season.startAt?.getTime() ?? Date.UTC(b.season.year, 0)) - (a.season.startAt?.getTime() ?? Date.UTC(a.season.year, 0)))
    .map((entry) => ({
      league: entry.season.league?.name ?? null,
      season: seasonLabel(entry.season.name),
      slug: entry.season.slug,
      points: entry.totalPoints,
      rank: entry.rank,
      field: entry.season._count.entries,
      starts: entry.starts,
      wins: entry.wins,
      podiums: entry.podiums,
      bestFinish: entry.bestFinish,
      car: entry.carDisplay,
    }))

  const races = results
    .filter((r) => r.session.event)
    .sort((a, b) => b.session.event!.startsAtUtc.getTime() - a.session.event!.startsAtUtc.getTime() || b.session.startedAt.getTime() - a.session.startedAt.getTime())
    .map((r) => {
      const event = r.session.event!
      const round = roundOf(event.title, event.series)
      return {
        id: r.id,
        eventSlug: event.slug,
        title: round ? `${round.name} · ${round.track}` : event.title,
        series: event.series?.title ?? null,
        date: event.startsAtUtc.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: event.timezone || DEFAULT_TIMEZONE }),
        position: r.position,
        field: r.session._count.results,
        points: r.points,
        bestLapTime: r.bestLapTime,
        laps: r.lapsCompleted,
        finished: !/dnf|dns|dsq|disq/i.test(r.status),
        status: r.status,
        car: r.participant.carMapping?.displayName ?? r.participant.carName,
      }
    })

  // Cars driven, most raced first
  const carMap = new Map<string, { car: string; races: number; wins: number; bestFinish: number }>()
  for (const race of races) {
    const car = carMap.get(race.car) ?? { car: race.car, races: 0, wins: 0, bestFinish: Infinity }
    car.races += 1
    if (race.position === 1) car.wins += 1
    car.bestFinish = Math.min(car.bestFinish, race.position)
    carMap.set(race.car, car)
  }
  const cars = [...carMap.values()].sort((a, b) => b.races - a.races || a.bestFinish - b.bestFinish)

  const events = attended.map(({ event }) => ({
    slug: event.slug,
    title: event.title,
    series: event.series?.title ?? null,
    date: event.startsAtUtc.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: event.timezone || DEFAULT_TIMEZONE }),
  }))

  return { user, driver, seasons, races, cars, events }
})

export type DriverProfile = NonNullable<Awaited<ReturnType<typeof getDriverProfile>>>
