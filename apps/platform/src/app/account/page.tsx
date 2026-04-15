import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCachedSessionUser } from '@/server/auth/cached-session';
import { updateMarketingOptIn, updateNotificationPreferences, retireAccount, deleteAccount } from './actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { MarketingToggle } from '@/components/marketing-toggle';
import { ConfirmSubmitButton } from '@/components/confirm-submit-button';
import { NotificationPreferences } from '@/components/notification-preferences';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const { user } = await getCachedSessionUser();
  if (!user) redirect('/login');

  // Fetch notification preferences
  const notificationPrefs = await prisma.notificationPreference.findUnique({
    where: { userId: user.id },
  });

  // Default preferences if none exist
  const preferences = notificationPrefs ?? {
    emailRegistration: true,
    emailWaitlistPromotion: true,
    emailEventReminder: false,
    emailEventPosted: false,
    emailResultsPosted: false,
  };

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen pt-20 pb-20">
      <div className="mx-auto max-w-4xl px-6 md:px-8 space-y-12">
        <div>
          <h1 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal">
            Account <span className="text-lsr-orange">Settings</span>
          </h1>
          <p className="font-sans font-medium text-white/60 mt-4 max-w-2xl leading-relaxed">
            Manage your driver profile, preferences, and account settings.
          </p>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ACCOUNT SETTINGS */}
        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.2em]">Profile Information</h2>
            <Button asChild variant="outline" size="sm" className="rounded-none border-white/10 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px]">
              <Link href={`/drivers/${user.handle}/edit`}>Edit Profile</Link>
            </Button>
          </div>
          <div className="rounded-none border border-white/5 bg-white/[0.03] p-8">
            <div className="grid md:grid-cols-2 gap-8">
              <div className="grid gap-2">
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">Email</Label>
                <Input value={user.email ?? ''} readOnly className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium" />
              </div>
              <div className="grid gap-2">
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">EID</Label>
                <Input value={user.eid ?? ''} readOnly className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium" />
              </div>
              <div className="grid gap-2">
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">Display Name</Label>
                <Input value={user.displayName} readOnly className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium" />
              </div>
              <div className="grid gap-2">
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">Handle</Label>
                <Input value={`@${user.handle}`} readOnly className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium" />
              </div>
              <div className="grid gap-2">
                <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">Racing Number</Label>
                <Input 
                  value={user.racingNumber !== null ? `#${user.racingNumber}` : 'None'} 
                  readOnly 
                  className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium"
                  style={user.racingNumber !== null ? { color: user.racingNumberColor || undefined, fontFamily: user.racingNumberFont || undefined } : undefined}
                />
              </div>
            </div>
          </div>
        </section>

        {/* COMMUNICATION PREFERENCES */}
        <section className="space-y-6">
          <h2 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.2em]">Communication Preferences</h2>

          {/* Master Email Toggle */}
          <form action={updateMarketingOptIn} className="rounded-none border border-white/5 bg-white/[0.03] p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h3 className="font-display font-bold italic text-xl text-white uppercase tracking-tight">Email Notifications</h3>
              <p className="font-sans text-sm text-white/50 mt-2 max-w-md">
                Enable email notifications and marketing updates. Turning this off disables all emails.
              </p>
            </div>
            <div className="flex items-center gap-6">
              <MarketingToggle
                name="marketingOptIn"
                defaultChecked={user.marketingOptIn}
              />
              <Button type="submit" size="sm" className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-10 transition-all px-6">
                Save
              </Button>
            </div>
          </form>

          {/* Granular Notification Preferences */}
          <form action={updateNotificationPreferences} className="rounded-none border border-white/5 bg-white/[0.03] p-8">
            <div className="mb-6">
              <h3 className="font-display font-bold italic text-xl text-white uppercase tracking-tight">Notification Types</h3>
              <p className="font-sans text-sm text-white/50 mt-2 max-w-md">
                Choose which email notifications you want to receive.
                {!user.marketingOptIn && (
                  <span className="block mt-2 text-lsr-orange">
                    Enable email notifications above to customize these settings.
                  </span>
                )}
              </p>
            </div>
            <NotificationPreferences
              preferences={preferences}
              disabled={!user.marketingOptIn}
            />
          </form>
        </section>

        <div className="w-full h-px bg-white/5" />

        {/* DANGER ZONE */}
        <section className="space-y-6">
          <h2 className="font-sans font-bold text-xs text-red-500 uppercase tracking-[0.2em]">Danger Zone</h2>
          
          <div className="grid gap-6 md:grid-cols-2">
            {/* RETIRE */}
            <div className="rounded-none border border-white/5 bg-white/[0.03] p-8 flex flex-col h-full">
              <h3 className="font-display font-bold italic text-xl text-white uppercase tracking-tight">Retire Account</h3>
              <p className="font-sans text-sm text-white/50 mt-4 mb-8 flex-grow leading-relaxed">
                You’ll be signed out and marked as <span className="text-white font-bold">retired</span>. Your driver
                page and stats remain visible, but you won’t be able to use the site.
              </p>
              <form action={retireAccount}>
                <Button type="submit" variant="outline" className="w-full rounded-none border-white/10 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12">
                  Retire
                </Button>
              </form>
            </div>

            {/* DELETE */}
            <div className="rounded-none border border-red-500/20 bg-red-500/[0.05] p-8 flex flex-col h-full">
              <h3 className="font-display font-bold italic text-xl text-red-500 uppercase tracking-tight">Delete Account</h3>
              <p className="font-sans text-sm text-red-500/70 mt-4 mb-8 flex-grow leading-relaxed">
                Permanently remove your profile and all associated data. This action cannot be undone.
              </p>
              <form action={deleteAccount}>
                <ConfirmSubmitButton
                  type="submit"
                  variant="destructive"
                  message="This will permanently delete your account. Are you sure?"
                  className="w-full rounded-none bg-red-600 hover:bg-red-700 text-white font-bold uppercase tracking-widest text-[10px] h-12"
                >
                  Permanently Delete
                </ConfirmSubmitButton>
              </form>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

