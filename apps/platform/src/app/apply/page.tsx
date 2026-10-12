import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ApplyNotice, ApplyShell } from "@/components/apply/apply-shell";
import { SignInToApplyButton } from "@/components/apply/sign-in-button";
import { primaryButton } from "@/components/apply/apply-styles";
import { formatCentral } from "@/lib/recruiting/labels";
import { tracks } from "@/schemas/recruiting.schema";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getApplyAvailability } from "@/server/services/recruiting-apply.service";
import { getMyApplication } from "@/server/services/recruiting.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Apply | Longhorn Sim Racing",
  robots: { index: false, follow: false },
};

export default async function ApplyPage() {
  const availability = await getApplyAvailability();
  if (availability.state === "off") notFound();

  if (availability.state === "no-round") {
    return (
      <ApplyShell kicker="Longhorn Sim Racing" title="Apply">
        <ApplyNotice>Applications aren&apos;t open right now. Check back soon, or follow us on social media for the next round.</ApplyNotice>
      </ApplyShell>
    );
  }

  const { round } = availability;
  const { user } = await getCachedSessionUser();
  const mine = user ? await getMyApplication(user.id) : null;

  let action: React.ReactNode = null;
  if (availability.state === "open") {
    if (!user) action = <SignInToApplyButton />;
    else if (mine?.state === "SUBMITTED")
      action = (
        <Button asChild className={primaryButton}>
          <Link href="/apply/status">See my application</Link>
        </Button>
      );
    else
      action = (
        <Button asChild className={primaryButton}>
          <Link href="/apply/start">{mine ? "Continue my application" : "Start my application"}</Link>
        </Button>
      );
  } else if (mine) {
    action = (
      <Button asChild className={primaryButton}>
        <Link href="/apply/status">See my application</Link>
      </Button>
    );
  }

  return (
    <ApplyShell kicker={round.name} title="Join the team">
      <div className="space-y-10">
        <ApplyNotice action={action}>
          {availability.state === "upcoming" && <>Applications open {formatCentral(round.opensAt)}.</>}
          {availability.state === "open" && (
            <>
              Applications are open until <strong className="text-white">{formatCentral(round.closesAt)}</strong>. You need an account to apply, and you can apply to more than one team in a single application.
            </>
          )}
          {availability.state === "closed" && <>Applications for this round closed {formatCentral(round.closesAt)}.</>}
        </ApplyNotice>

        <section aria-labelledby="teams-heading" className="space-y-4">
          <h2 id="teams-heading" className="font-display text-2xl font-black uppercase italic">Teams</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {tracks.map((t) => (
              <li key={t.key} className="border border-white/10 bg-white/[0.02] p-4">
                <p className="font-display text-lg font-black uppercase italic">{t.label}</p>
                <p className="mt-1 font-sans text-sm text-white/60">{t.blurb}</p>
                <p className="mt-2 font-sans text-[11px] font-bold uppercase tracking-widest text-white/40">{t.interviewRequired ? "Interview required" : "No interview"}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="how-heading" className="space-y-3 font-sans text-sm leading-relaxed text-white/65">
          <h2 id="how-heading" className="font-display text-2xl font-black uppercase italic text-white">How it works</h2>
          <ol className="list-decimal space-y-2 pl-5">
            <li>Check your details, pick the teams you want, and answer one page of questions for each.</li>
            <li>Add a link to your resume. Your progress is saved as you go, so you can leave and come back.</li>
            <li>Submit. All your teams are submitted together, and you can&apos;t edit afterwards.</li>
            <li>If your application is complete at the deadline, we submit it for you. An unfinished application is not submitted.</li>
          </ol>
        </section>
      </div>
    </ApplyShell>
  );
}
