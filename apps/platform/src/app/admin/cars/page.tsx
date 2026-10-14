import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { CarsConsole, type CarRow } from "@/components/admin/cars-console"
import { getUnmappedCarNames } from "./actions"

export const metadata: Metadata = { title: "Car mapping" }

export default async function CarsPage() {
  await requireOfficerPage()
  const [mappedCars, unmappedCarNames, usage] = await Promise.all([
    prisma.carMapping.findMany({ orderBy: { gameCarName: "asc" } }),
    getUnmappedCarNames(),
    // How many race entries used each car, so the common ones get mapped first
    prisma.raceParticipant.groupBy({ by: ["carName"], _count: { _all: true } }),
  ])

  const entries = new Map(usage.map((row) => [row.carName, row._count._all]))
  const mappedNames = new Set(mappedCars.map((car) => car.gameCarName))
  const rows: CarRow[] = [
    // A name can only be mapped once, so skip unlinked entries whose name already has a mapping
    ...unmappedCarNames
      .filter((name) => !mappedNames.has(name))
      .map((name) => ({ id: null, gameCarName: name, displayName: name, secondaryDisplayName: null, entries: entries.get(name) ?? 0 })),
    ...mappedCars.map((car) => ({
      id: car.id,
      gameCarName: car.gameCarName,
      displayName: car.displayName,
      secondaryDisplayName: car.secondaryDisplayName,
      entries: entries.get(car.gameCarName) ?? 0,
    })),
  ]
  const unmapped = rows.filter((row) => !row.id).length

  return (
    <>
      <PageHeader
        title="Car mapping"
        description={`Turns the sim's car names (like ferrari_296_gt3) into the names shown on the site.${unmapped ? ` ${unmapped} not mapped yet.` : ""}`}
      />
      <CarsConsole cars={rows} />
    </>
  )
}
