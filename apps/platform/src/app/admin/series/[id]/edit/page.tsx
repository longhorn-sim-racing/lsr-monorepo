import { getSeries } from "@/server/queries/series";
import { SeriesForm } from "@/components/admin/series-form";
import { notFound } from "next/navigation";
import { requireOfficerPage } from "@/server/auth/guards";

type EditSeriesArgs = {
  params: Promise<{ id: string }>;
};

export default async function EditSeriesPage({ params }: EditSeriesArgs) {
  await requireOfficerPage();
  const { id } = await params;
  const series = await getSeries(id);

  if (!series) {
    return notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold mb-6">Edit Series</h1>
      <SeriesForm series={series} />
    </main>
  );
}