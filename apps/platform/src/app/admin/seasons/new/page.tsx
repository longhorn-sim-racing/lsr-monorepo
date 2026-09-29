import { getAllSeries } from "@/server/queries/series";
import { SeasonForm } from "../form";
import { prisma } from "@/server/db";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function NewSeasonPage() {
  await requireOfficerPage();
  const [series, leagues] = await Promise.all([
    getAllSeries(),
    prisma.league.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-3xl font-bold mb-6">Create New Season</h1>
      <SeasonForm seriesList={series} leagues={leagues} />
    </main>
  );
}
