import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@/server/db';
import { getCachedSessionUser } from '@/server/auth/cached-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateProfile } from './actions';
import { AvatarUploader } from '@/components/avatar-uploader';
import { UpdateRacingNumberButton } from '@/components/racing-number-prompt';
import { RacingNumber } from '@/components/racing-number';
import { initials } from '../../names';

export const dynamic = 'force-dynamic';

const labelClass = 'font-sans font-bold text-[11px] uppercase tracking-[0.2em] text-white/55';
// 16px text on phones so iOS doesn't zoom into the field
const inputClass =
  'h-12 rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm';

function FormField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={labelClass}>{label}</Label>
      {children}
      {hint && <p className="font-sans text-xs text-white/45">{hint}</p>}
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="relative border border-white/10 bg-white/[0.02] p-5 md:p-7">
      <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
      <h2 className="flex items-baseline gap-3 font-display font-black italic text-2xl uppercase text-white">
        <span className="text-lsr-orange">{n}</span>
        {title}
      </h2>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

export default async function EditDriverPage({
  params,
}: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  const pageUser = await prisma.user.findUnique({ where: { handle } });
  if (!pageUser || pageUser.status === 'deleted') return notFound();

  const { user: sessionUser } = await getCachedSessionUser();
  if (!sessionUser) {
    redirect(`/auth/signin?next=/drivers/${encodeURIComponent(handle)}/edit`);
  }

  if (sessionUser.id !== pageUser.id) {
    redirect(`/drivers/${sessionUser.handle}`);
  }

  const socials = (pageUser.socials as Record<string, string> | null) ?? {};

  return (
    <div className="bg-lsr-charcoal text-white min-h-screen">
      <div className="border-b border-white/10 bg-black/25">
        <div className="mx-auto max-w-6xl px-6 md:px-8 pt-10 pb-10 md:pt-14 md:pb-12">
          <Link href={`/drivers/${handle}`} className="group inline-flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
            Your driver page
          </Link>
          <p className="mt-8 font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-lsr-orange">Your driver page</p>
          <h1 className="mt-3 font-display font-black italic text-5xl md:text-6xl uppercase leading-[0.9]">
            Edit <span className="text-lsr-orange">profile</span>
          </h1>
          <p className="mt-4 max-w-xl font-sans text-sm md:text-base leading-relaxed text-white/65">
            This is what the roster and your driver page show. Everything except your name is optional.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-8 py-10 md:py-14">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)] lg:items-start lg:gap-12">
          {/* How you appear */}
          <aside className="relative border border-white/10 bg-white/[0.02] p-6 lg:sticky lg:top-24 lg:order-2">
            <div className="absolute top-0 left-0 h-1 w-16 bg-lsr-orange" />
            <p className="font-sans font-bold text-[10px] uppercase tracking-[0.3em] text-white/45">How you appear</p>
            <div className="mt-5 flex items-center gap-4">
              <span className="relative h-16 w-16 shrink-0 overflow-hidden border border-white/15 bg-black">
                {pageUser.avatarUrl ? (
                  <Image src={pageUser.avatarUrl} alt="" fill sizes="64px" className="object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center font-display font-black italic text-xl text-white/30">{initials(pageUser.displayName)}</span>
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate font-display font-black italic text-2xl uppercase leading-none">{pageUser.displayName}</p>
                <p className="mt-1 truncate font-sans text-xs text-white/50">@{pageUser.handle}</p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-between gap-4 border-t border-white/10 pt-5">
              <div>
                <p className={labelClass}>Car number</p>
                <div className="mt-1.5">
                  <RacingNumber user={pageUser} size="md" fallback={<span className="font-sans text-sm text-white/45">None yet</span>} />
                </div>
              </div>
              <UpdateRacingNumberButton user={pageUser} />
            </div>
            <p className="mt-5 border-t border-white/10 pt-5 font-sans text-xs leading-relaxed text-white/50">
              Your car number and photo save right away. The rest saves with the button at the bottom.
            </p>
          </aside>

          <div className="space-y-4 lg:order-1">
            <Step n="1" title="Photo">
              <AvatarUploader initialUrl={pageUser.avatarUrl} />
            </Step>

            <form action={updateProfile} className="space-y-4">
              <Step n="2" title="Driver details">
                <FormField id="displayName" label="Display name" hint="How you show up on the roster and in results.">
                  <Input id="displayName" name="displayName" defaultValue={pageUser.displayName} required className={inputClass} />
                </FormField>
                <div className="grid gap-6 sm:grid-cols-2">
                  <FormField id="major" label="Major">
                    <Input id="major" name="major" defaultValue={pageUser.major ?? ''} placeholder="e.g. Mechanical Engineering" className={inputClass} />
                  </FormField>
                  <FormField id="gradYear" label="Graduating year">
                    <Input id="gradYear" name="gradYear" type="number" defaultValue={pageUser.gradYear ?? ''} placeholder="e.g. 2028" className={inputClass} />
                  </FormField>
                </div>
                <FormField id="iRating" label="iRating" hint="Only if you race on iRacing.">
                  <Input id="iRating" name="iRating" type="number" defaultValue={pageUser.iRating ?? ''} className={inputClass} />
                </FormField>
                <FormField id="bio" label="Bio" hint="A few lines about you: how you got into racing, favourite track, what you drive.">
                  <Textarea
                    id="bio"
                    name="bio"
                    rows={5}
                    defaultValue={pageUser.bio ?? ''}
                    className="rounded-none border-white/15 bg-white/[0.04] text-base text-white placeholder:text-white/30 focus-visible:border-lsr-orange focus-visible:ring-1 focus-visible:ring-lsr-orange md:text-sm"
                  />
                </FormField>
              </Step>

              <Step n="3" title="Links">
                <div className="grid gap-6 sm:grid-cols-2">
                  <FormField id="instagram" label="Instagram">
                    <Input id="instagram" name="instagram" type="url" placeholder="https://instagram.com/handle" defaultValue={socials.instagram ?? ''} className={inputClass} />
                  </FormField>
                  <FormField id="twitch" label="Twitch">
                    <Input id="twitch" name="twitch" type="url" placeholder="https://twitch.tv/handle" defaultValue={socials.twitch ?? ''} className={inputClass} />
                  </FormField>
                  <FormField id="youtube" label="YouTube">
                    <Input id="youtube" name="youtube" type="url" placeholder="https://youtube.com/@channel" defaultValue={socials.youtube ?? ''} className={inputClass} />
                  </FormField>
                  <FormField id="website" label="Website">
                    <Input id="website" name="website" type="url" placeholder="https://example.com" defaultValue={socials.website ?? ''} className={inputClass} />
                  </FormField>
                </div>
              </Step>

              <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                <Button type="submit" className="h-12 rounded-none bg-lsr-orange px-8 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal">
                  Save changes
                </Button>
                <Button type="button" variant="outline" asChild className="h-12 rounded-none border-white/20 bg-transparent px-8 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal">
                  <Link href={`/drivers/${handle}`}>Cancel</Link>
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
