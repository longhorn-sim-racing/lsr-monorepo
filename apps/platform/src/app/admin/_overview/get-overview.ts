import type { Prisma } from "@prisma/client"
import { missingResultsWhere as missingResultsFor, RESULTS_LOOKBACK_DAYS } from "@/lib/events"
import { prisma } from "@/server/db"

const DAY = 24 * 60 * 60 * 1000

export { RESULTS_LOOKBACK_DAYS }

/**
 * Everything the admin Overview shows, in one round of cheap queries (counts and small `take`s).
 * Nothing here is cached or estimated: every number is a count of rows as of this request.
 */
export async function getOverview(now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * DAY)
  const weekAhead = new Date(now.getTime() + 7 * DAY)

  // Ended events in a series that has a season (a racing series), with no ingested upload. "Ended" matches
  // getEffectiveEventStatus: published (or auto-published) and past its end time, or a legacy COMPLETED.
  // The digest's results check uses the same rule
  const missingResultsWhere: Prisma.EventWhereInput = missingResultsFor(now)

  // Events running now or starting in the next 7 days. Drafts have their own list; cancelled ones don't need anything.
  const upcomingWhere: Prisma.EventWhereInput = {
    startsAtUtc: { lte: weekAhead },
    endsAtUtc: { gte: now },
    status: { notIn: ["DRAFT", "CANCELLED", "POSTPONED"] },
  }

  const paymentsWhere: Prisma.PaymentWhereInput = { createdAt: { gte: weekAgo } }

  const [
    missingResults,
    missingResultsCount,
    drafts,
    draftsCount,
    upcoming,
    upcomingCount,
    applications,
    applicationsThisWeek,
    payments,
    paymentsByStatus,
    collected,
    activity,
  ] = await Promise.all([
    prisma.event.findMany({
      where: missingResultsWhere,
      orderBy: { startsAtUtc: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        startsAtUtc: true,
        series: { select: { title: true } },
        rawResultUploads: { select: { id: true, status: true }, orderBy: { uploadedAt: "desc" }, take: 1 },
      },
    }),
    prisma.event.count({ where: missingResultsWhere }),
    prisma.event.findMany({
      where: { status: "DRAFT" },
      orderBy: { startsAtUtc: "asc" },
      take: 5,
      select: { id: true, title: true, startsAtUtc: true, series: { select: { title: true } } },
    }),
    prisma.event.count({ where: { status: "DRAFT" } }),
    prisma.event.findMany({
      where: upcomingWhere,
      orderBy: { startsAtUtc: "asc" },
      take: 6,
      select: {
        id: true,
        title: true,
        status: true,
        publishedAt: true,
        startsAtUtc: true,
        endsAtUtc: true,
        registrationEnabled: true,
        registrationMax: true,
      },
    }),
    prisma.event.count({ where: upcomingWhere }),
    prisma.leagueApplication.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        createdAt: true,
        source: true,
        user: { select: { displayName: true, handle: true } },
        season: { select: { name: true, slug: true } },
      },
    }),
    prisma.leagueApplication.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.payment.findMany({
      where: paymentsWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        createdAt: true,
        amountCents: true,
        status: true,
        user: { select: { displayName: true } },
        product: { select: { name: true } },
        eventRegistration: { select: { event: { select: { title: true } } } },
      },
    }),
    prisma.payment.groupBy({ by: ["status"], where: paymentsWhere, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { ...paymentsWhere, status: "succeeded" }, _sum: { amountCents: true } }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        actionType: true,
        entityType: true,
        summary: true,
        actor: { select: { displayName: true } },
      },
    }),
  ])

  // Registration counts for the upcoming events, by status
  const registrationRows = upcoming.length
    ? await prisma.eventRegistration.groupBy({
        by: ["eventId", "status"],
        where: { eventId: { in: upcoming.map((event) => event.id) }, status: { in: ["REGISTERED", "WAITLISTED"] } },
        _count: { _all: true },
      })
    : []
  const registrations = (eventId: string, status: "REGISTERED" | "WAITLISTED") =>
    registrationRows.find((row) => row.eventId === eventId && row.status === status)?._count._all ?? 0

  const paymentCount = (status: string) => paymentsByStatus.find((row) => row.status === status)?._count._all ?? 0

  return {
    now,
    missingResults: { count: missingResultsCount, items: missingResults },
    drafts: { count: draftsCount, items: drafts },
    upcoming: {
      count: upcomingCount,
      items: upcoming.map((event) => ({
        ...event,
        registered: registrations(event.id, "REGISTERED"),
        waitlisted: registrations(event.id, "WAITLISTED"),
      })),
    },
    applications: { thisWeek: applicationsThisWeek, items: applications },
    payments: {
      total: paymentsByStatus.reduce((sum, row) => sum + row._count._all, 0),
      succeeded: paymentCount("succeeded"),
      pending: paymentCount("pending"),
      failed: paymentCount("failed"),
      refunded: paymentCount("refunded"),
      collectedCents: collected._sum.amountCents ?? 0,
      items: payments,
    },
    activity,
  }
}

export type Overview = Awaited<ReturnType<typeof getOverview>>
