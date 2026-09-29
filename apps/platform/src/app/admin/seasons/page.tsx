import { getAllSeasons } from "@/server/queries/seasons";
import { SeasonsConsole } from "@/components/admin/seasons-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function SeasonsAdminPage() {
  await requireOfficerPage();
  const seasons = await getAllSeasons();

  return (
    <div className="h-full">
      <SeasonsConsole initialSeasons={seasons} />
    </div>
  );
}