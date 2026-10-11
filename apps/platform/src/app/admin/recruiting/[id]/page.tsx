import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { requireOfficerPage } from "@/server/auth/guards";
import { findCycleById } from "@/server/repos/application.repo";
import { getApplicationDetail, recordApplicationViewed } from "@/server/services/recruiting.service";
import { genericQuestions, getTrack, questionsForTrack } from "@/schemas/recruiting.schema";
import { answerEntries, readPortfolioLinks } from "@/lib/recruiting/answers";
import { formatCentral } from "@/lib/recruiting/labels";
import { AnswerList } from "@/components/admin/recruiting/answer-list";
import { SafeLink } from "@/components/admin/recruiting/safe-link";
import { StatusBadge } from "@/components/admin/recruiting/status-badge";
import { EmailsSection, TrackPanel, type PanelEmail } from "@/components/admin/recruiting/track-panel";

export const metadata: Metadata = { title: "Application | LSR Admin" };
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
  const app = await getApplicationDetail(id);
  if (!app) notFound();
  const cycle = await findCycleById(app.cycleId);
  await recordApplicationViewed(officer.id, app.id, app.userId);

  const isOwn = app.userId === officer.id;
  const name = app.fullName?.trim() || app.user.displayName;
  const portfolio = readPortfolioLinks(app.portfolioLinks);

  return (
    <div className="mx-auto max-w-4xl space-y-6 font-mono text-sm text-white">
      <Link href={`/admin/recruiting${cycle ? `?cycle=${cycle.slug}` : ""}`} className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/50 hover:text-white">
        <ArrowLeft size={14} /> All applications
      </Link>

      <header className="rounded-lg border border-white/10 bg-black/40 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-black uppercase italic">{name}</h1>
          {app.tracks.map((t) => (
            <span key={t.id} className="flex items-center gap-1.5 text-[11px] text-white/50">
              {getTrack(t.track)?.label ?? t.track} <StatusBadge status={t.status} />
            </span>
          ))}
        </div>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2">
          <Fact label="Account email">
            <a href={`mailto:${app.user.email}`} className="text-lsr-orange hover:underline">{app.user.email}</a>
          </Fact>
          <Fact label="UT EID">{app.eid ?? "—"}</Fact>
          <Fact label="Graduation year">{app.gradYear ?? "—"}</Fact>
          <Fact label="Major">{app.major ?? "—"}</Fact>
          <Fact label="Round">{cycle?.name ?? "—"}</Fact>
          <Fact label="Submitted">
            {formatCentral(app.submittedAt)}
            {app.autoSubmitted && <span className="ml-2 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">submitted automatically at the deadline</span>}
          </Fact>
        </dl>
      </header>

      <section className="rounded-lg border border-white/10 bg-black/40 p-4">
        <h2 className="mb-3 text-[11px] uppercase tracking-wider text-lsr-orange">Resume and portfolio</h2>
        <p className="mb-3 text-[11px] text-white/40">
          These are links the applicant typed. Open them like any link from a stranger; if one doesn&apos;t open, ask the applicant to share it with &ldquo;anyone with the link&rdquo;.
        </p>
        <dl className="space-y-3 text-xs">
          <Fact label="Resume">{app.resumeUrl ? <SafeLink url={app.resumeUrl} /> : "—"}</Fact>
          <Fact label="Portfolio">
            {portfolio.length === 0 ? (
              "—"
            ) : (
              <ul className="space-y-1">
                {portfolio.map((l) => (
                  <li key={l.url}>
                    <SafeLink url={l.url} label={l.label} />
                  </li>
                ))}
              </ul>
            )}
          </Fact>
        </dl>
      </section>

      <section className="rounded-lg border border-white/10 bg-black/40 p-4">
        <h2 className="mb-3 text-[11px] uppercase tracking-wider text-lsr-orange">General answers</h2>
        <AnswerList entries={answerEntries(genericQuestions, app.genericAnswers)} />
      </section>

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

      <section className="rounded-lg border border-white/10 bg-black/40 p-4">
        <EmailsSection emails={app.emails.map(toPanelEmail)} canResend={!isOwn} title="Confirmation email" emptyText="No confirmation email was recorded." />
      </section>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="mt-0.5 text-white/90">{children}</dd>
    </div>
  );
}
