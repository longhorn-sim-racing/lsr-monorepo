import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { getTrackConfigs, listCycles } from "@/server/services/recruiting-cycle.service";
import { tracks } from "@/schemas/recruiting.schema";
import { DEFAULT_TIMEZONE, dateToZonedValue } from "@/lib/dates";
import { CyclesConsole } from "@/components/admin/recruiting/cycles-console";

export const metadata: Metadata = { title: "Recruiting rounds" };
export const dynamic = "force-dynamic";

export default async function RecruitingCyclesPage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  await requireOfficerPage();
  const sp = await searchParams;

  const cycles = await listCycles();
  const selected = cycles.find((c) => c.slug === sp.cycle) ?? cycles.find((c) => c.isActive) ?? cycles[0] ?? null;
  const links = selected ? await getTrackConfigs(selected.id) : {};

  return (
    <CyclesConsole
      cycles={cycles.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        isActive: c.isActive,
        window: c.window,
        opensAt: c.opensAt.toISOString(),
        closesAt: c.closesAt.toISOString(),
        // The form inputs show and take Central time
        opensLocal: dateToZonedValue(c.opensAt, DEFAULT_TIMEZONE),
        closesLocal: dateToZonedValue(c.closesAt, DEFAULT_TIMEZONE),
        submitted: c.submitted,
        drafts: c.drafts,
      }))}
      selectedSlug={selected?.slug ?? null}
      links={links}
      interviewTeams={tracks.filter((t) => t.interviewRequired).map((t) => ({ key: t.key, label: t.label }))}
    />
  );
}
