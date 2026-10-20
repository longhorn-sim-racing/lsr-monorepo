import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { findCycleById } from "@/server/repos/application.repo";
import { getApplicationDetail, recordApplicationViewed } from "@/server/services/recruiting.service";
import { genericQuestions, getTrack, questionsForTrack } from "@/schemas/recruiting.schema";
import { answerEntries } from "@/lib/recruiting/answers";
import { formatCentral } from "@/lib/recruiting/labels";
import { Badge, DetailList, PageHeader, Panel, PanelBody, PanelHeader } from "@/components/admin/kit";
import { AnswerList } from "@/components/admin/recruiting/answer-list";
import { SafeLink } from "@/components/recruiting/safe-link";
import { StatusBadge } from "@/components/admin/recruiting/status-badge";
import { EmailsSection, TrackPanel, type PanelEmail } from "@/components/admin/recruiting/track-panel";

export const metadata: Metadata = { title: "Application" };
export const dynamic = "force-dynamic";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toPanelEmail = (m: { id: string; template: string; subject: string; status: string; error: string | null; sentAt: Date | null; createdAt: Date }): PanelEmail => ({
  id: m.id,
  template: m.template,
  subject: m.subject,
  status: m.status,
  error: m.error,
  sentAt: iso(m.sentAt),
  createdAt: m.createdAt.toISOString(),
});

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const officer = await requireOfficerPage();
  const { id } = await params;

  // Null for a draft or an unknown id, so a draft can't be opened by guessing its id
  const app = await getApplicationDetail(id, officer.id);
  if (!app) notFound();
  const cycle = await findCycleById(app.cycleId);
  await recordApplicationViewed(officer.id, app.id, app.userId);

  const isOwn = app.userId === officer.id;
  const name = app.fullName?.trim() || app.user.displayName;

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader
        back={{ href: `/admin/recruiting${cycle ? `?cycle=${cycle.slug}` : ""}`, label: "All applications" }}
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {app.tracks.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5">
                {getTrack(t.track)?.label ?? t.track} <StatusBadge status={t.status} />
              </span>
            ))}
          </span>
        }
      />

      <Panel>
        <PanelBody>
          <DetailList
            className="sm:grid-cols-[minmax(96px,auto)_1fr_minmax(96px,auto)_1fr]"
            items={[
              { label: "Account email", value: <a href={`mailto:${app.user.email}`} className="font-medium underline underline-offset-2 hover:text-primary">{app.user.email}</a> },
              { label: "UT EID", value: app.eid ?? "—" },
              { label: "Graduation year", value: app.gradYear ?? "—" },
              { label: "Major", value: app.major ?? "—" },
              { label: "Round", value: cycle?.name ?? "—" },
              {
                label: "Submitted",
                value: (
                  <>
                    {formatCentral(app.submittedAt)}
                    {app.autoSubmitted && <Badge tone="warning" className="ml-2">submitted automatically at the deadline</Badge>}
                  </>
                ),
              },
            ]}
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Resume"
          description="This is a link the applicant typed. Open it like any link from a stranger; if it doesn't open, ask the applicant to share it with “anyone with the link”."
        />
        <PanelBody>
          <DetailList items={[{ label: "Resume", value: app.resumeUrl ? <SafeLink url={app.resumeUrl} tone="admin" /> : "—" }]} />
        </PanelBody>
      </Panel>

      {genericQuestions.length > 0 && (
        <Panel>
          <PanelHeader title="General answers" />
          <PanelBody>
            <AnswerList entries={answerEntries(genericQuestions, app.genericAnswers)} />
          </PanelBody>
        </Panel>
      )}

      {app.tracks.map((t) => {
        const def = getTrack(t.track);
        return (
          <TrackPanel
            key={t.id}
            trackId={t.id}
            teamLabel={def?.label ?? t.track}
            interviewRequired={def?.interviewRequired ?? false}
            status={t.status}
            decidedAt={iso(t.decidedAt)}
            decidedBy={t.decidedBy?.displayName ?? null}
            applicantName={name}
            isOwn={isOwn}
            reviews={t.reviews.map((r) => ({ id: r.id, score: r.score, notes: r.notes, createdAt: r.createdAt.toISOString(), reviewer: r.reviewer?.displayName ?? null }))}
            emails={t.emails.map(toPanelEmail)}
          >
            <AnswerList entries={answerEntries(questionsForTrack(t.track), t.answers)} />
          </TrackPanel>
        );
      })}

      <Panel>
        <PanelBody>
          <EmailsSection emails={app.emails.map(toPanelEmail)} canResend={!isOwn} title="Confirmation email" emptyText="No confirmation email was recorded." />
        </PanelBody>
      </Panel>
    </div>
  );
}
