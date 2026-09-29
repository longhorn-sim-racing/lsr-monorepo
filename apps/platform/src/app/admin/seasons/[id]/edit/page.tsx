import { getAllSeries } from "@/server/queries/series";
import { getSeasonById } from "@/server/queries/seasons";
import { SeasonForm } from "../../form";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";

export default async function EditSeasonPage({
  params,
}: {
  params: { id: string };
}) {
  const awaitedParams = await params;
  const [season, series, leagues] = await Promise.all([
    getSeasonById(awaitedParams.id),
    getAllSeries(),
    prisma.league.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  if (!season) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-3xl font-bold mb-6">Edit Season</h1>
      <SeasonForm initialData={season} seriesList={series} leagues={leagues} />
    </main>
  );
}
