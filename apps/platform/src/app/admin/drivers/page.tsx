import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { DriversConsole, type DriverRow } from "@/components/admin/drivers-console"

export const metadata: Metadata = { title: "Driver mapping" }

export default async function DriversPage() {
  await requireOfficerPage()
  const [drivers, sessions] = await Promise.all([
    prisma.driverIdentity.findMany({
      orderBy: { lastSeenName: "asc" },
      select: {
        id: true,
        driverGuid: true,
        lastSeenName: true,
        user: { select: { id: true, displayName: true, handle: true, email: true, avatarUrl: true, eid: true } },
      },
    }),
    // How many ingested sessions each GUID drove in, so the busiest unmapped drivers stand out
    prisma.raceParticipant.groupBy({ by: ["driverGuid"], _count: { _all: true } }),
  ])

  const sessionCount = new Map(sessions.map((row) => [row.driverGuid, row._count._all]))
  const rows: DriverRow[] = drivers.map((driver) => ({
    id: driver.id,
    guid: driver.driverGuid,
    name: driver.lastSeenName,
    user: driver.user,
    sessions: sessionCount.get(driver.driverGuid) ?? 0,
  }))
  const unmapped = rows.filter((row) => !row.user).length

  return (
    <>
      <PageHeader
        title="Driver mapping"
        description={`Links each sim driver to a member, so their results count for them.${unmapped ? ` ${unmapped} not mapped yet.` : ""}`}
      />
      <DriversConsole drivers={rows} />
    </>
  )
}
