import Link from "next/link";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { countEmailsNeedingAttention } from "@/server/repos/application.repo";
import { countTrackApplications, listTrackApplications } from "@/server/services/recruiting.service";
import { listCycles } from "@/server/services/recruiting-cycle.service";
import { isTrackKey, tracks } from "@/schemas/recruiting.schema";
import { parseTrackStatus } from "@/lib/recruiting/labels";
import { isReplyToMissing } from "@/server/services/recruiting-email.service";
import { RecruitingConsole } from "@/components/admin/recruiting/recruiting-console";
import { PipelinePanel } from "@/components/admin/recruiting/pipeline-panel";
import { getPipelinePanel } from "@/server/queries/recruiting-pipeline";
import { Button, EmptyState, PageHeader, Panel } from "@/components/admin/kit";

export const metadata: Metadata = { title: "Recruiting" };
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
      <>
        <PageHeader title="Recruiting" />
        <Panel>
          <EmptyState
            title="There are no recruiting rounds yet"
            description="A round sets when applications open and close. Create one to get started."
            action={
              <Button variant="primary" asChild>
                <Link href="/admin/recruiting/cycles">Create the first round</Link>
              </Button>
            }
          />
        </Panel>
      </>
    );
  }

  const cycle = cycles.find((c) => c.slug === sp.cycle) ?? cycles.find((c) => c.isActive) ?? cycles[0];
  // Anything in the URL is untrusted: only known teams and statuses become filters
  const team = sp.team && isTrackKey(sp.team) ? sp.team : undefined;
  const status = parseTrackStatus(sp.status);
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const autoSubmitted = sp.auto === "1" ? true : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const [list, counts, attention, pipeline] = await Promise.all([
    listTrackApplications({ cycleId: cycle.id, viewerId: officer.id, track: team, status, autoSubmitted, q, take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    countTrackApplications(cycle.id),
    countEmailsNeedingAttention(cycle.id),
    // The summary is extra: if it fails, the list still loads
    getPipelinePanel(cycle.id, officer.id).catch((error) => {
      console.error("[recruiting] Couldn't load the pipeline summary:", error);
      return null;
    }),
  ]);

  return (
    <>
      <PageHeader title="Recruiting" description={`${cycle.name}${cycle.isActive ? " (active round)" : ""}`} />
      {pipeline && <PipelinePanel data={pipeline} teamHref={(key) => `/admin/recruiting?cycle=${encodeURIComponent(cycle.slug)}&team=${encodeURIComponent(key)}`} />}
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
      replyToMissing={isReplyToMissing()}
    />
    </>
  );
}
