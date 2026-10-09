import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, BookOpen, CalendarDays, Mail } from "lucide-react";
import { prisma } from "@/server/db";
import { getCachedSessionUser } from "@/server/auth/cached-session";
import { getActiveEntitlements } from "@/server/repos/membership.repo";
import { priceForUser, productRequiresMembership } from "@/server/services/product-pricing";
import { getActiveLeagueEntry, getLeagueApplication, getOpenLeagueSeason } from "@/server/services/league-entry.service";
import { LeagueEntryForm } from "@/components/league-entry-form";
import { CloudinaryImage } from "@/components/cloudinary-image";
import { RacingNumber } from "@/components/racing-number";
import { LSC_RULES_SLUG } from "@/lib/page-slugs";
import { publicEventWhere } from "@/lib/events";
import { parseRoundTitle } from "@/lib/rounds";
import { seasonLabel, seasonTerm } from "@/lib/seasons";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { zoneLabel } from "@/server/queries/schedule";
import { UpdateRacingNumberButton } from "@/components/racing-number-prompt";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Enter the Lone Star Cup",
  robots: { index: false },
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Shell({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <div className="relative overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 z-0">
          <CloudinaryImage
            publicId="gallery/lone-star-cup-season-2/lsc2monza"
            alt=""
            fill
            preload
            sizes="100vw"
            className="object-cover object-[center_60%] opacity-55"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-lsr-charcoal/70 via-lsr-charcoal/40 to-lsr-charcoal" />
          <div className="absolute inset-0 bg-gradient-to-r from-lsr-charcoal/95 via-lsr-charcoal/60 to-transparent" />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 md:px-8 pt-12 pb-10 md:pt-16 md:pb-14">
          <Link href="/lone-star-cup" className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            Lone Star Cup
          </Link>
          <p className="mt-8 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">{kicker}</p>
          <h1 className="mt-3 font-display font-black italic text-5xl md:text-7xl uppercase leading-[0.9]">
            Enter the <span className="text-lsr-orange">Lone Star Cup</span>
          </h1>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-6 md:px-8 py-12 md:py-16">{children}</div>
    </div>
  );
}

function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="relative max-w-2xl space-y-6 border border-white/10 bg-white/[0.02] p-6 md:p-8">
      <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
      <p className="font-sans text-base leading-relaxed text-white/75">{children}</p>
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
      <Shell kicker="Entry closed">
        <Notice
          action={
            <Button asChild className="h-12 rounded-none border border-white/20 bg-transparent px-6 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href="/lone-star-cup">Back to the Lone Star Cup</Link>
            </Button>
          }
        >
          Lone Star Cup entry is closed right now. It opens again with the next season; watch Discord for the date.
        </Notice>
      </Shell>
    );
  }

  const now = new Date();
  const [entry, application, price, entitlements, rulesPage, rounds] = await Promise.all([
    getActiveLeagueEntry(user.id, league.id),
    getLeagueApplication(user.id, season.id),
    priceForUser(product, user.id),
    getActiveEntitlements(user.id),
    prisma.page.findUnique({ where: { slug: LSC_RULES_SLUG }, select: { visibility: true } }),
    season.seriesId
      ? prisma.event.findMany({
          where: { ...publicEventWhere(now), seriesId: season.seriesId },
          orderBy: { startsAtUtc: "asc" },
          select: { title: true, startsAtUtc: true, endsAtUtc: true, timezone: true },
        })
      : [],
  ]);
  if (entry) redirect("/lone-star-cup");

  const label = seasonLabel(season.name);
  const term = seasonTerm(season.startAt);

  if (productRequiresMembership(product) && !entitlements.some((e) => e.kind === "lsr_member")) {
    return (
      <Shell kicker={label}>
        <Notice
          action={
            <Button asChild className="h-12 rounded-none bg-lsr-orange px-6 font-sans text-xs font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
              <Link href="/account">Pay dues</Link>
            </Button>
          }
        >
          Lone Star Cup entry needs an active LSR membership. Pay your dues on your account page, then come back here.
        </Notice>
      </Shell>
    );
  }

  const nextIndex = rounds.findIndex((round) => round.endsAtUtc > now);
  const nextRound = nextIndex === -1 ? null : rounds[nextIndex];
  const nextParsed = nextRound ? parseRoundTitle(nextRound.title, nextIndex) : null;
  const nextWhen = nextRound
    ? nextRound.startsAtUtc.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: nextRound.timezone || DEFAULT_TIMEZONE,
      }) + ` ${zoneLabel(nextRound.startsAtUtc, nextRound.timezone || DEFAULT_TIMEZONE)}`
    : null;
  const rulesPublic = rulesPage?.visibility === "public";

  return (
    <Shell kicker={`${label}${term ? ` · ${term}` : ""}`}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start lg:gap-14">
        {/* Summary: first on phones, beside the form on desktop */}
        <aside className="relative border border-white/10 bg-white/[0.02] p-6 md:p-8 lg:sticky lg:top-24 lg:order-2">
          <div className="absolute top-0 left-0 h-1 w-24 bg-lsr-orange" />
          <Image src="/images/lone-star-cup-logo.png" alt="" width={509} height={218} className="h-auto w-32" />
          <p className="mt-5 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">{label} entry</p>
          <p className="mt-2 font-display font-black italic text-6xl leading-none text-white">{dollars(price.amountCents)}</p>
          {price.tier === "returning" ? (
            <p className="mt-2 font-sans text-sm font-bold text-emerald-300">Returning driver rate</p>
          ) : price.returningAmountCents !== null ? (
            <p className="mt-2 font-sans text-sm text-white/55">{dollars(price.returningAmountCents)} for returning drivers</p>
          ) : null}
          <p className="mt-4 font-sans text-sm leading-relaxed text-white/70">Covers both the Lone Star Cup and the Formula Sunday League.</p>

          {nextParsed && nextWhen && (
            <div className="mt-6 flex items-start gap-3 border-t border-white/10 pt-5">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-lsr-orange" aria-hidden />
              <p className="font-sans text-sm text-white/75">
                Next up: <span className="font-bold text-white">{nextParsed.name}, {nextParsed.track}</span>
                <span className="block text-white/55">{nextWhen}</span>
              </p>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between gap-4 border-t border-white/10 pt-5">
            <div className="min-w-0">
              <p className="font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/45">Your car number</p>
              {user.racingNumber !== null ? (
                <RacingNumber user={user} size="md" className="mt-1 block" />
              ) : (
                <p className="mt-1 font-sans text-sm text-white/65">Not picked yet. First come, first served.</p>
              )}
            </div>
            <UpdateRacingNumberButton user={user} />
          </div>

          <ul className="mt-5 space-y-2 border-t border-white/10 pt-5 font-sans text-sm">
            {rulesPublic && (
              <li>
                <Link href="/lone-star-cup/rules" target="_blank" className="inline-flex items-center gap-2 text-white/75 hover:text-lsr-orange">
                  <BookOpen className="h-4 w-4 text-lsr-orange" aria-hidden />
                  Read the rules
                </Link>
              </li>
            )}
            <li>
              <a href="mailto:info@longhornsimracing.org" className="inline-flex items-center gap-2 text-white/75 hover:text-lsr-orange">
                <Mail className="h-4 w-4 text-lsr-orange" aria-hidden />
                Payment or refund questions
              </a>
            </li>
          </ul>
        </aside>

        <div className="lg:order-1">
          <ol className="mb-10 grid gap-3 sm:grid-cols-3">
            {[
              ["01", "Fill this out", "A minute or two."],
              ["02", "Pay on Stripe", "A secure Stripe checkout."],
              ["03", "Get on the grid", "The comp team adds you on Discord."],
            ].map(([n, title, text]) => (
              <li key={n} className="border border-white/10 bg-white/[0.02] p-4">
                <span className="font-display font-black italic text-2xl text-lsr-orange">{n}</span>
                <p className="mt-1 font-sans font-bold text-sm uppercase tracking-tight text-white">{title}</p>
                <p className="mt-1 font-sans text-xs text-white/55">{text}</p>
              </li>
            ))}
          </ol>
          {rulesPublic && (
            <p className="mb-8 font-sans text-sm leading-relaxed text-white/65">
              Entering means you agree to the{" "}
              <Link href="/lone-star-cup/rules" target="_blank" className="font-bold text-lsr-orange hover:text-white">
                Lone Star Cup rules
              </Link>
              .
            </p>
          )}
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
        </div>
      </div>
    </Shell>
  );
}
