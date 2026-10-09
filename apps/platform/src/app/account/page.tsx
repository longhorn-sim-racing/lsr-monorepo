import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, BadgeCheck, CalendarDays, Pencil } from 'lucide-react';
import { getCachedSessionUser } from '@/server/auth/cached-session';
import { updateMarketingOptIn, updateNotificationPreferences, retireAccount, deleteAccount } from './actions';
import { Button } from '@/components/ui/button';
import { MarketingToggle } from '@/components/marketing-toggle';
import { ConfirmSubmitButton } from '@/components/confirm-submit-button';
import { NotificationPreferences } from '@/components/notification-preferences';
import { UpdateRacingNumberButton } from '@/components/racing-number-prompt';
import { RacingNumber } from '@/components/racing-number';
import { AgendaRow } from '@/components/events/agenda-row';
import { prisma } from '@/server/db';
import { getActiveEntitlements } from '@/server/repos/membership.repo';
import { getSchedule } from '@/server/queries/schedule';
import { ProductCheckoutButton, ProductPaymentToast } from '@/components/product-checkout-button';
import { AccountHeader } from './account-header';

export const dynamic = 'force-dynamic';

function Section({ id, kicker, title, aside, children, tone }: { id: string; kicker: string; title: string; aside?: React.ReactNode; children: React.ReactNode; tone?: 'danger' }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={`font-sans font-bold text-[10px] uppercase tracking-[0.3em] ${tone === 'danger' ? 'text-red-400' : 'text-lsr-orange'}`}>{kicker}</p>
          <h2 id={`${id}-title`} className="mt-2 font-display font-black italic text-3xl uppercase leading-none text-white">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const card = 'relative border border-white/10 bg-white/[0.02] p-6 md:p-8';
const cardTick = <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />;

export default async function AccountPage() {
  const { user } = await getCachedSessionUser();
  if (!user) redirect('/auth/signin?next=/account');

  const [notificationPrefs, entitlements, dues, schedule] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId: user.id } }),
    getActiveEntitlements(user.id),
    prisma.product.findFirst({ where: { type: 'ANNUAL_DUES', active: true } }),
    getSchedule(user.id).catch(() => []),
  ]);
  const membership = entitlements.find((entitlement) => entitlement.kind === 'lsr_member');
  const myEvents = schedule.filter((event) => event.viewer && !event.ended);

  // Default preferences if none exist
  const preferences = notificationPrefs ?? {
    emailRegistration: true,
    emailWaitlistPromotion: true,
    emailEventReminder: false,
    emailEventPosted: false,
    emailResultsPosted: false,
  };

  const details: { label: string; value: React.ReactNode }[] = [
    { label: 'Display name', value: user.displayName },
    { label: 'Handle', value: `@${user.handle}` },
    { label: 'Email', value: user.email ?? '' },
    {
      label: 'UT EID',
      value: user.eid ?? <span className="text-white/45">Not added yet. You can add it when you enter the Lone Star Cup.</span>,
    },
  ];

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <ProductPaymentToast />
      <AccountHeader user={user} active="settings" kicker="Your account" />

      <div className="mx-auto max-w-5xl px-6 md:px-8 py-12 md:py-16 space-y-16 md:space-y-20">
        {/* What you're signed up for */}
        <Section
          id="events"
          kicker="Coming up"
          title="Your events"
          aside={
            <Link href="/events" className="group inline-flex items-center gap-2 font-sans font-bold text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-lsr-orange">
              Full schedule <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </Link>
          }
        >
          {myEvents.length > 0 ? (
            <ul className="space-y-2">
              {myEvents.slice(0, 5).map((event) => (
                <AgendaRow key={event.slug} event={event} titleAs="h3" />
              ))}
            </ul>
          ) : (
            <div className={`${card} flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`}>
              {cardTick}
              <p className="flex items-center gap-3 font-sans text-sm text-white/65">
                <CalendarDays className="h-5 w-5 shrink-0 text-lsr-orange" aria-hidden />
                You&apos;re not registered for anything coming up.
              </p>
              <Button asChild className="h-11 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                <Link href="/events">Find an event</Link>
              </Button>
            </div>
          )}
        </Section>

        <div className="grid gap-16 md:gap-20 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-8">
          {/* Profile */}
          <Section
            id="profile"
            kicker="On the roster"
            title="Profile"
            aside={
              <Button asChild className="h-10 rounded-none border border-white/20 bg-transparent px-4 font-sans text-[10px] font-bold uppercase tracking-widest text-white hover:bg-white hover:text-lsr-charcoal">
                <Link href={`/drivers/${user.handle}/edit`}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit profile
                </Link>
              </Button>
            }
          >
            <div className={card}>
              {cardTick}
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                {details.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt className="font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white/45">{item.label}</dt>
                    <dd className="mt-1.5 break-words font-sans text-sm text-white">{item.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6">
                <div>
                  <p className="font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white/45">Car number</p>
                  <div className="mt-1.5">
                    <RacingNumber user={user} size="md" fallback={<span className="font-sans text-sm text-white/45">None yet</span>} />
                  </div>
                </div>
                <UpdateRacingNumberButton user={user} />
              </div>
            </div>
          </Section>

          {/* Membership: only when someone holds one or dues are on sale (no dues some semesters) */}
          {(membership || dues) && (
            <Section id="membership" kicker="Longhorn Sim Racing" title="Membership">
              <div className={card}>
                {cardTick}
                {membership ? (
                  <div className="flex items-start gap-3">
                    <BadgeCheck className="mt-0.5 h-6 w-6 shrink-0 text-emerald-300" aria-hidden />
                    <div>
                      <p className="font-display font-black italic text-2xl uppercase text-white">LSR member</p>
                      {membership.validTo && (
                        <p className="mt-1 font-sans text-sm text-white/65">
                          Through {membership.validTo.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                        </p>
                      )}
                    </div>
                  </div>
                ) : dues ? (
                  <div className="space-y-4">
                    <p className="font-sans text-sm leading-relaxed text-white/70">Pay your annual dues to become an LSR member.</p>
                    <ProductCheckoutButton product="ANNUAL_DUES" label="Pay dues" priceCents={dues.amountCents} />
                    <p className="font-sans text-xs leading-relaxed text-white/50">
                      For payment issues or refunds, contact{' '}
                      <a href="mailto:info@longhornsimracing.org" className="border-b border-white/10 text-white/70 transition-colors hover:border-lsr-orange hover:text-lsr-orange">
                        info@longhornsimracing.org
                      </a>
                      .
                    </p>
                  </div>
                ) : null}
              </div>
            </Section>
          )}
        </div>

        {/* Email */}
        <Section id="email" kicker="What lands in your inbox" title="Email preferences">
          <div className="space-y-4">
            {/* Master email toggle */}
            <form action={updateMarketingOptIn} className={`${card} flex flex-col gap-6 md:flex-row md:items-center md:justify-between`}>
              {cardTick}
              <div>
                <h3 className="font-sans font-bold text-base text-white">Club updates</h3>
                <p className="mt-1.5 max-w-lg font-sans text-sm leading-relaxed text-white/60">
                  News, new events, results and announcements from LSR. Turning this off doesn&apos;t stop payment receipts or emails about events you&apos;ve signed up for.
                </p>
              </div>
              <div className="flex items-center gap-5">
                <MarketingToggle name="marketingOptIn" defaultChecked={user.marketingOptIn} />
                <Button type="submit" size="sm" className="h-10 rounded-none bg-lsr-orange px-6 font-bold uppercase tracking-widest text-[10px] text-white transition-all hover:bg-white hover:text-lsr-charcoal">
                  Save
                </Button>
              </div>
            </form>

            {/* Granular notification preferences */}
            <form action={updateNotificationPreferences} className={card}>
              {cardTick}
              <div className="mb-6">
                <h3 className="font-sans font-bold text-base text-white">Notification emails</h3>
                <p className="mt-1.5 max-w-lg font-sans text-sm leading-relaxed text-white/60">
                  Choose which emails you get. Payment receipts are always emailed.
                  {!user.marketingOptIn && (
                    <span className="mt-2 block text-lsr-orange">New events and race results also need club updates turned on.</span>
                  )}
                </p>
              </div>
              <NotificationPreferences preferences={preferences} />
            </form>
          </div>
        </Section>

        {/* Danger zone */}
        <Section id="danger" kicker="Careful" title="Leave LSR" tone="danger">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex h-full flex-col border border-white/10 bg-white/[0.02] p-6 md:p-8">
              <h3 className="font-sans font-bold text-base text-white">Retire your account</h3>
              <p className="mt-2 mb-8 flex-grow font-sans text-sm leading-relaxed text-white/60">
                You&apos;ll be signed out and marked as <span className="font-bold text-white">retired</span>. Your driver page and stats stay visible, but you won&apos;t be able to use the site.
              </p>
              <form action={retireAccount}>
                <Button type="submit" variant="outline" className="h-12 w-full rounded-none border-white/15 bg-transparent font-bold uppercase tracking-widest text-[10px] text-white hover:bg-white hover:text-lsr-charcoal">
                  Retire
                </Button>
              </form>
            </div>

            <div className="flex h-full flex-col border border-red-500/25 bg-red-500/[0.05] p-6 md:p-8">
              <h3 className="font-sans font-bold text-base text-red-300">Delete your account</h3>
              <p className="mt-2 mb-8 flex-grow font-sans text-sm leading-relaxed text-red-200/70">
                Permanently remove your profile and all associated data. This can&apos;t be undone.
              </p>
              <form action={deleteAccount}>
                <ConfirmSubmitButton
                  type="submit"
                  variant="destructive"
                  message="This will permanently delete your account. Are you sure?"
                  className="h-12 w-full rounded-none bg-red-600 font-bold uppercase tracking-widest text-[10px] text-white hover:bg-red-700"
                >
                  Permanently delete
                </ConfirmSubmitButton>
              </form>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
