import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply/apply-form";
import { ApplyShell } from "@/components/apply/apply-shell";
import { formStateFromSaved } from "@/lib/recruiting/steps";
import { tracks } from "@/schemas/recruiting.schema";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getApplyAvailability } from "@/server/services/recruiting-apply.service";
import { getApplicantStatus, getOrCreateDraft } from "@/server/services/recruiting.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your application | Longhorn Sim Racing",
  robots: { index: false, follow: false },
};

export default async function StartPage() {
  const availability = await getApplyAvailability();
  if (availability.state === "off") notFound();

  const { user } = await getCachedSessionUser();
  if (!user) redirect("/auth/signin?next=/apply/start");

  if (availability.state === "no-round" || availability.state === "upcoming") redirect("/apply");
  if (availability.state === "closed") redirect("/apply/status");

  await getOrCreateDraft(user.id);
  const view = await getApplicantStatus(user.id);
  const app = view.application;
  if (!app) redirect("/apply");
  if (app.state === "SUBMITTED") redirect("/apply/status");

  return (
    <ApplyShell kicker={availability.round.name} title="Your application" wide>
      <ApplyForm
        initial={formStateFromSaved({ profile: app.profile, resumeUrl: app.resumeUrl, portfolioLinks: app.portfolioLinks, genericAnswers: app.genericAnswers, tracks: app.tracks })}
        initialStep={app.draftStep}
        accountEmail={user.email}
        round={{ name: availability.round.name, closesAt: availability.round.closesAt.toISOString() }}
        teams={tracks.map((t) => ({ key: t.key, label: t.label, blurb: t.blurb, interviewRequired: t.interviewRequired }))}
      />
    </ApplyShell>
  );
}
