import { prisma } from "@/server/db";
import { getUnmappedCarNames } from "./actions";
import { CarsConsole } from "@/components/admin/cars-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function CarsPage() {
  await requireOfficerPage();
  const [mappedCars, unmappedCarNames] = await Promise.all([
    prisma.carMapping.findMany({
      orderBy: { gameCarName: "asc" },
    }),
    getUnmappedCarNames(),
  ]);

  return (
    <div className="h-full">
      <CarsConsole mappedCars={mappedCars} unmappedCarNames={unmappedCarNames} />
    </div>
  );
}