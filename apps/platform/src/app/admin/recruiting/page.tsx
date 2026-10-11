import Link from "next/link";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { countEmailsNeedingAttention } from "@/server/repos/application.repo";
import { countTrackApplications, listTrackApplications } from "@/server/services/recruiting.service";
import { listCycles } from "@/server/services/recruiting-cycle.service";
import { isTrackKey, tracks } from "@/schemas/recruiting.schema";
import { parseTrackStatus } from "@/lib/recruiting/labels";
import { RecruitingConsole } from "@/components/admin/recruiting/recruiting-console";

export const metadata: Metadata = { title: "Recruiting | LSR Admin" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function RecruitingAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ cycle?: string; team?: string; status?: string; q?: string; auto?: string; page?: string }>;
}) {
  // The admin layout checks too, but layouts don't re-run on every render; this page lists applicants' details.
  const officer = await requireOfficerPage();
  const sp = await searchParams;

  const cycles = await listCycles();
  if (cycles.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-3 font-mono text-sm text-white/70">
        <h1 className="font-display text-2xl font-black uppercase italic text-white">Recruiting</h1>
        <p>There are no recruiting rounds yet.</p>
        <Link href="/admin/recruiting/cycles" className="text-lsr-orange hover:underline">Create the first round</Link>
      </div>
    );
  }

  const cycle = cycles.find((c) => c.slug === sp.cycle) ?? cycles.find((c) => c.isActive) ?? cycles[0];
  // Anything in the URL is untrusted: only known teams and statuses become filters
  const team = sp.team && isTrackKey(sp.team) ? sp.team : undefined;
  const status = parseTrackStatus(sp.status);
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const autoSubmitted = sp.auto === "1" ? true : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const [list, counts, attention] = await Promise.all([
    listTrackApplications({ cycleId: cycle.id, track: team, status, autoSubmitted, q, take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    countTrackApplications(cycle.id),
    countEmailsNeedingAttention(cycle.id),
  ]);

  return (
    <RecruitingConsole
      viewerId={officer.id}
      cycles={cycles.map((c) => ({ id: c.id, slug: c.slug, name: c.name, isActive: c.isActive }))}
      cycle={{ id: cycle.id, slug: cycle.slug, name: cycle.name, isActive: cycle.isActive, window: cycle.window, opensAt: cycle.opensAt.toISOString(), closesAt: cycle.closesAt.toISOString(), drafts: cycle.drafts }}
      teams={tracks.map((t) => ({ key: t.key, label: t.label, interviewRequired: t.interviewRequired }))}
      counts={counts}
      rows={list.rows.map((r) => ({
        id: r.id,
        track: r.track,
        status: r.status,
        applicationId: r.application.id,
        userId: r.application.userId,
        name: r.application.fullName,
        email: r.application.email,
        gradYear: r.application.gradYear,
        major: r.application.major,
        submittedAt: r.application.submittedAt?.toISOString() ?? null,
        autoSubmitted: r.application.autoSubmitted,
        reviewCount: r.reviewCount,
        averageScore: r.averageScore,
      }))}
      total={list.total}
      page={page}
      pageSize={PAGE_SIZE}
      filters={{ team, status, q, auto: autoSubmitted === true }}
      attentionCount={attention}
    />
  );
}
