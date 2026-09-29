import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/server/db";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getActiveEntitlements } from "@/server/repos/membership.repo";
import { priceForUser, productRequiresMembership } from "@/server/services/product-pricing";
import { getActiveLeagueEntry, getLeagueApplication, getOpenLeagueSeason } from "@/server/services/league-entry.service";
import { LeagueEntryForm } from "@/components/league-entry-form";
import { UpdateRacingNumberButton } from "@/components/racing-number-prompt";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Enter the Lone Star Cup",
  robots: { index: false },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-2xl px-6 md:px-8 py-14 md:py-20">
        <Link href="/lone-star-cup" className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/40 transition-colors hover:text-lsr-orange">
          ← Lone Star Cup
        </Link>
        <h1 className="mt-6 font-display font-black italic text-4xl md:text-5xl text-white uppercase tracking-normal leading-[0.9]">
          Enter the <span className="text-lsr-orange">Lone Star Cup</span>
        </h1>
        <div className="mt-10">{children}</div>
      </div>
    </main>
  );
}

function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="space-y-6 border border-white/10 bg-white/[0.02] p-8">
      <p className="font-sans text-sm text-white/70">{children}</p>
      {action}
    </div>
  );
}

export default async function EnterLoneStarCupPage() {
  const session = await getCachedSessionUser();
  if (!session.user) redirect("/auth/signin?next=/lone-star-cup/enter");
  const user = session.user;

  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" }, select: { id: true } });
  const [season, product] = await Promise.all([
    league ? getOpenLeagueSeason(league.id) : null,
    prisma.product.findFirst({ where: { type: "LEAGUE_FEE", league: { slug: "lone-star-cup" }, active: true } }),
  ]);

  if (!league || !season || !product) {
    return (
      <Shell>
        <Notice>Lone Star Cup entry is currently unavailable. Check back when the next season opens.</Notice>
      </Shell>
    );
  }

  const [entry, application, price, entitlements] = await Promise.all([
    getActiveLeagueEntry(user.id, league.id),
    getLeagueApplication(user.id, season.id),
    priceForUser(product, user.id),
    getActiveEntitlements(user.id),
  ]);
  if (entry) redirect("/lone-star-cup");

  if (productRequiresMembership(product) && !entitlements.some((e) => e.kind === "lsr_member")) {
    return (
      <Shell>
        <Notice
          action={
            <Button asChild className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href="/account">Pay dues</Link>
            </Button>
          }
        >
          Lone Star Cup entry requires an active LSR membership. Pay your dues first, then come back here.
        </Notice>
      </Shell>
    );
  }

  const seasonName = season.name.split("|").pop()!.trim();

  return (
    <Shell>
      <div className="mb-10 space-y-3 font-sans text-sm leading-relaxed text-white/70">
        <p>
          {seasonName} entry is <span className="font-bold text-white">${(price.amountCents / 100).toFixed(2)}</span>
          {price.tier === "returning" ? " (returning driver rate)" : price.returningAmountCents !== null ? ` ($${(price.returningAmountCents / 100).toFixed(2)} for returning drivers)` : ""}
          . It covers both the Lone Star Cup and the Formula Sunday League. Fill this out, then you&apos;ll pay on Stripe.
        </p>
        <p className="text-xs text-white/40">
          Payment issues or refunds:{" "}
          <a href="mailto:info@longhornsimracing.org" className="text-white/60 hover:text-lsr-orange">info@longhornsimracing.org</a>
        </p>
      </div>

      <div className="mb-10 flex flex-wrap items-center justify-between gap-4 border border-white/10 bg-black/20 p-4">
        <div>
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">Your car number</p>
          <p className="mt-1 font-sans text-sm text-white/80">
            {user.racingNumber !== null ? `#${user.racingNumber}` : "Not picked yet. Numbers are first come, first served."}
          </p>
        </div>
        <UpdateRacingNumberButton user={user} />
      </div>

      <LeagueEntryForm
        priceCents={price.amountCents}
        isUpdate={!!application}
        defaults={{
          discordUsername: application?.discordUsername ?? "",
          experience: application?.experience ?? null,
          equipment: application?.equipment ?? [],
          canCommit: application?.canCommit ?? false,
          utStudent: application ? application.school === null : true,
          eid: user.eid ?? "",
          school: application?.school ?? "",
          notes: application?.notes ?? "",
        }}
      />
    </Shell>
  );
}
