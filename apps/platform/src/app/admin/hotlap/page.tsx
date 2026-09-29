import { getHotlapSettings } from "./actions";
import HotlapForm from "./hotlap-form";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function AdminHotlapPage() {
  await requireOfficerPage();
  const settings = await getHotlapSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Hotlap of the Week</h1>
        <p className="text-sm text-white/60 mt-1">
          Configure the featured hotlap video shown on the home page.
        </p>
      </div>

      <HotlapForm initial={settings} />
    </div>
  );
}
