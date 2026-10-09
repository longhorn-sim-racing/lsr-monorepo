import { SeriesForm } from "@/components/admin/series-form";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function NewSeriesPage() {
  await requireOfficerPage();
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold mb-6">New Event Series</h1>
      <SeriesForm />
    </div>
  );
}
