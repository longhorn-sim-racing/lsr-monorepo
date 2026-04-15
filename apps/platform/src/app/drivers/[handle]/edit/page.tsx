import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/server/db';
import { getCachedSessionUser } from '@/server/auth/cached-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateProfile } from './actions';
import { AvatarUploader } from '@/components/avatar-uploader';
import { UpdateRacingNumberButton } from '@/components/racing-number-prompt';

export const dynamic = 'force-dynamic';

function FormField({ id, label, children }: { id: string, label: string, children: React.ReactNode }) {
  return (
    <div className="grid md:grid-cols-3 gap-2">
      <Label htmlFor={id} className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] md:text-right pt-3">{label}</Label>
      <div className="md:col-span-2">
        {children}
      </div>
    </div>
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
    redirect('/login');
  }

  if (sessionUser.id !== pageUser.id) {
    redirect(`/drivers/${sessionUser.handle}`);
  }

  const socials = (pageUser.socials as Record<string, string> | null) ?? {};

  return (
    <main className="bg-lsr-charcoal text-white min-h-screen pt-20 pb-20">
      <div className="mx-auto max-w-4xl px-6 md:px-8 space-y-12">
        <div>
           <h1 className="font-display font-black italic text-4xl md:text-6xl text-white uppercase tracking-normal">
            Edit <span className="text-lsr-orange">Profile</span>
          </h1>
          <p className="font-sans font-medium text-white/60 mt-4 max-w-2xl leading-relaxed">
            Update your public profile information.
          </p>
        </div>

        <div className="w-full h-px bg-white/5" />

        <div className="space-y-8">
          {/* Avatar */}
           <section className="space-y-6">
            <h2 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.2em]">Profile Photo</h2>
            <div className="rounded-none border border-white/5 bg-white/[0.03] p-8">
                <AvatarUploader initialUrl={pageUser.avatarUrl} />
            </div>
          </section>

          {/* Form */}
          <form action={updateProfile} className="space-y-12">
            <section className="space-y-6">
                <h2 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.2em]">Driver Details</h2>
                <div className="rounded-none border border-white/5 bg-white/[0.03] p-8 space-y-6">
                <FormField id="displayName" label="Display Name">
                    <Input id="displayName" name="displayName" defaultValue={pageUser.displayName} required
                        className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="iRating" label="iRating">
                    <Input id="iRating" name="iRating" type="number" defaultValue={pageUser.iRating ?? ''}
                        className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <div className="space-y-2">
                  <Label className="font-sans font-bold text-[10px] text-white/40 uppercase tracking-[0.2em] pl-1">Racing Number</Label>
                  <div className="flex items-center gap-4 h-12">
                    <div className="text-2xl flex-1 px-3 py-2 bg-white/5 border border-white/10 flex items-center">
                      <span 
                        style={pageUser.racingNumber !== null ? { 
                          color: pageUser.racingNumberColor || undefined, 
                          fontFamily: pageUser.racingNumberFont || undefined,
                          fontStyle: pageUser.racingNumberItalic ? 'italic' : 'normal',
                          fontWeight: 900,
                          WebkitTextStroke: pageUser.racingNumberBorder ? '1px white' : 'none',
                        } : { color: 'rgba(255,255,255,0.4)' }}
                      >
                        {pageUser.racingNumber !== null ? `#${pageUser.racingNumber}` : 'None'}
                      </span>
                    </div>
                    <UpdateRacingNumberButton user={pageUser} />
                  </div>
                </div>
                <FormField id="gradYear" label="Graduating Year">
                    <Input id="gradYear" name="gradYear" type="number" defaultValue={pageUser.gradYear ?? ''}
                        className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="major" label="Major">
                    <Input id="major" name="major" defaultValue={pageUser.major ?? ''}
                        className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="bio" label="Bio">
                    <Textarea id="bio" name="bio" rows={5} defaultValue={pageUser.bio ?? ''}
                            className="rounded-none bg-white/5 border-white/10 text-white font-medium focus:ring-lsr-orange" />
                </FormField>
                </div>
            </section>

            <section className="space-y-6">
                <h2 className="font-sans font-bold text-xs text-lsr-orange uppercase tracking-[0.2em]">Social Links</h2>
                <div className="rounded-none border border-white/5 bg-white/[0.03] p-8 space-y-6">
                <FormField id="website" label="Website">
                    <Input id="website" name="website" type="url" placeholder="https://example.com"
                        defaultValue={socials.website ?? ''} className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="instagram" label="Instagram">
                    <Input id="instagram" name="instagram" type="url" placeholder="https://instagram.com/handle"
                        defaultValue={socials.instagram ?? ''} className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="twitch" label="Twitch">
                    <Input id="twitch" name="twitch" type="url" placeholder="https://twitch.tv/handle"
                        defaultValue={socials.twitch ?? ''} className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                <FormField id="youtube" label="YouTube">
                    <Input id="youtube" name="youtube" type="url" placeholder="https://youtube.com/@channel"
                        defaultValue={socials.youtube ?? ''} className="rounded-none bg-white/5 border-white/10 text-white h-12 font-medium focus:ring-lsr-orange" />
                </FormField>
                </div>
            </section>

            <div className="flex gap-4 pt-2">
              <Button type="submit" className="rounded-none bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all">
                Save changes
              </Button>
              <Button type="button" variant="outline" asChild className="rounded-none border-white/20 text-white hover:bg-white hover:text-lsr-charcoal font-bold uppercase tracking-widest text-[10px] h-12 px-8 transition-all">
                <a href={`/drivers/${handle}`}>Cancel</a>
              </Button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}

