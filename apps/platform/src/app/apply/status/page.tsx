import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ApplicationSummary } from "@/components/apply/application-summary";
import { ApplyNotice, ApplyShell } from "@/components/apply/apply-shell";
import { primaryButton } from "@/components/apply/apply-styles";
import { expiredDraftCopy, teamStatusCopy, type StatusTone } from "@/lib/recruiting/status-copy";
import { formatCentral } from "@/lib/recruiting/labels";
import { formStateFromSaved, stepCompletion } from "@/lib/recruiting/steps";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getApplyAvailability } from "@/server/services/recruiting-apply.service";
import { getApplicantStatus } from "@/server/services/recruiting.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Application status | Longhorn Sim Racing",
  robots: { index: false, follow: false },
};

const TONE_BAR: Record<StatusTone, string> = { neutral: "bg-white/30", progress: "bg-sky-400", good: "bg-green-500", bad: "bg-red-500" };

export default async function StatusPage({ searchParams }: { searchParams: Promise<{ submitted?: string }> }) {
  const availability = await getApplyAvailability();
  if (availability.state === "off") notFound();

  const { user } = await getCachedSessionUser();
  if (!user) redirect("/auth/signin?next=/apply/status");

  const { submitted } = await searchParams;
  const view = await getApplicantStatus(user.id);
  const app = view.application;

  if (!app) {
    return (
      <ApplyShell kicker="Longhorn Sim Racing" title="Your application">
        <ApplyNotice
          action={
            availability.state === "open" ? (
              <Button asChild className={primaryButton}>
                <Link href="/apply/start">Start my application</Link>
              </Button>
            ) : undefined
          }
        >
          You don&apos;t have an application in this round.
        </ApplyNotice>
      </ApplyShell>
    );
  }

  const saved = { profile: app.profile, resumeUrl: app.resumeUrl, portfolioLinks: app.portfolioLinks, genericAnswers: app.genericAnswers, tracks: app.tracks };
  const summary = (
    <ApplicationSummary
      profile={{ ...app.profile, email: user.email }}
      resumeUrl={app.resumeUrl}
      portfolioLinks={app.portfolioLinks}
      genericAnswers={app.genericAnswers}
      teams={app.tracks.map((t) => ({ key: t.track, answers: t.answers }))}
    />
  );
  const kicker = view.round?.name ?? "Longhorn Sim Racing";

  if (app.state === "DRAFT") {
    if (!app.expiredUnsubmitted) {
      return (
        <ApplyShell kicker={kicker} title="Your application">
          <ApplyNotice
            action={
              <Button asChild className={primaryButton}>
                <Link href="/apply/start">Continue my application</Link>
              </Button>
            }
          >
            Your application isn&apos;t submitted yet. It closes {formatCentral(view.round?.closesAt)}.
          </ApplyNotice>
        </ApplyShell>
      );
    }
    const complete = stepCompletion(formStateFromSaved(saved), user.email).complete;
    const copy = expiredDraftCopy(complete);
    return (
      <ApplyShell kicker={kicker} title="Your application">
        <div className="space-y-8">
          <ApplyNotice tone={complete ? "neutral" : "bad"}>
            <p className="font-display text-xl font-black uppercase italic text-white">{copy.headline}</p>
            <p className="mt-2">{copy.detail}</p>
          </ApplyNotice>
          <details className="border border-white/10 bg-white/[0.02]">
            <summary className="cursor-pointer px-4 py-3 font-sans text-xs font-bold uppercase tracking-widest text-white/70">What you saved</summary>
            <div className="border-t border-white/10 p-4">{summary}</div>
          </details>
        </div>
      </ApplyShell>
    );
  }

  return (
    <ApplyShell kicker={kicker} title="Your application">
      <div className="space-y-8">
        {submitted === "1" && (
          <ApplyNotice tone="good">
            <p className="font-display text-xl font-black uppercase italic text-white">Application submitted</p>
            <p className="mt-2">Thank you. We send a confirmation to {user.email}; check your spam folder if it doesn&apos;t arrive. This page always shows your latest status, even if the email is delayed.</p>
          </ApplyNotice>
        )}
        <p className="font-sans text-sm text-white/60">
          {app.autoSubmitted ? "Submitted automatically at the deadline" : "Submitted"} {formatCentral(app.submittedAt)}. Applications can&apos;t be edited after they are submitted.
        </p>

        <ul className="space-y-3">
          {app.tracks.map((t) => {
            if (!t.status) return null;
            const copy = teamStatusCopy(t.status, { interviewRequired: t.interviewRequired, hasBookingUrl: !!t.bookingUrl });
            return (
              <li key={t.track} className="relative border border-white/10 bg-white/[0.03] p-5">
                <div className={`absolute left-0 top-0 h-full w-1 ${TONE_BAR[copy.tone]}`} />
                <p className="font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">{t.label}</p>
                <p className="mt-1 font-display text-xl font-black uppercase italic text-white">{copy.headline}</p>
                <p className="mt-1 font-sans text-sm text-white/65">{copy.detail}</p>
                {t.bookingUrl && (
                  <Button asChild className={`${primaryButton} mt-4`}>
                    <a href={t.bookingUrl} target="_blank" rel="noopener noreferrer nofollow">Book your interview</a>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        <details className="border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer px-4 py-3 font-sans text-xs font-bold uppercase tracking-widest text-white/70">What you submitted</summary>
          <div className="border-t border-white/10 p-4">{summary}</div>
        </details>
      </div>
    </ApplyShell>
  );
}
