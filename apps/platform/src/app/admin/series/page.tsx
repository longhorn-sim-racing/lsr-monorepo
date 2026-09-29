import { getAllSeries } from "@/server/queries/series";
import { SeriesConsole } from "@/components/admin/series-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function SeriesAdminPage() {
  await requireOfficerPage();
  const series = await getAllSeries();

  return (
    <div className="h-full">
      <SeriesConsole initialSeries={series} />
    </div>
  );
}