import Link from 'next/link';
import { formatInTimeZone } from 'date-fns-tz';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmSubmitButton } from '@/components/confirm-submit-button';
import { DEFAULT_TIMEZONE } from '@/lib/dates';
import type { LinkOutcome } from '@/server/services/discord-link.service';
import { unlinkDiscordAction } from './discord-actions';
import { labelClass } from './form-styles';

/** What the member sees after a link attempt (`?discord=` on the way back) */
const OUTCOME: Record<LinkOutcome, { text: string; ok?: boolean }> = {
  linked: { text: 'Discord linked.', ok: true },
  unlinked: { text: 'Discord unlinked.', ok: true },
  already: { text: 'Your profile already has a Discord account linked. Unlink it first to link a different one.' },
  taken: { text: "That Discord account is already linked to another member's profile. If it's yours, ask an officer to help." },
  cancelled: { text: "You cancelled on Discord, so nothing changed." },
  expired: { text: 'That link attempt expired, or was started in another browser or account. Try again from here.' },
  failed: { text: "Discord didn't confirm your account, so nothing changed. Try again in a minute." },
  unavailable: { text: "Linking Discord isn't available right now." },
};

export function isLinkOutcome(value: unknown): value is LinkOutcome {
  return typeof value === 'string' && Object.hasOwn(OUTCOME, value);
}

const buttonClass = 'h-12 rounded-none px-6 font-sans text-[10px] font-bold uppercase tracking-widest transition-all';

/**
 * The member's Discord link (design §12.1): link through Discord (identify only; the page posts to
 * /api/discord/oauth/start) or unlink. Shown while linking is available, or while there's a link to remove.
 */
export function DiscordLink({
  user,
  available,
  outcome,
}: {
  user: { discordUserId: string | null; discordUsername: string | null; discordLinkedAt: Date | null };
  available: boolean;
  outcome: LinkOutcome | null;
}) {
  const shown = outcome ? OUTCOME[outcome] : null;
  return (
    <div id="discord" className="scroll-mt-24 space-y-3 border-t border-white/10 pt-6">
      <p className={labelClass}>Discord</p>
      {shown && (
        <p
          role={shown.ok ? 'status' : 'alert'}
          className={
            shown.ok
              ? 'flex items-center gap-1.5 font-sans text-xs text-white/70'
              : 'border border-red-400/30 bg-red-500/10 px-4 py-3 font-sans text-xs leading-relaxed text-red-200'
          }
        >
          {shown.ok && <Check className="h-3.5 w-3.5 text-lsr-orange" aria-hidden />}
          {shown.text}
        </p>
      )}
      {user.discordUserId ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-sans text-sm text-white">
            Linked as <span className="font-bold">@{user.discordUsername ?? 'your Discord account'}</span>
            {user.discordLinkedAt && <span className="text-white/50"> since {formatInTimeZone(user.discordLinkedAt, DEFAULT_TIMEZONE, 'MMM d, yyyy')}</span>}
          </p>
          <form action={unlinkDiscordAction}>
            <ConfirmSubmitButton
              type="submit"
              message="Unlink your Discord account from your profile?"
              className={`${buttonClass} border border-white/20 bg-transparent text-white hover:bg-white hover:text-lsr-charcoal`}
            >
              Unlink Discord
            </ConfirmSubmitButton>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-sans text-sm leading-relaxed text-white/60">Tell the club which account is yours on its Discord server.</p>
          <form action="/api/discord/oauth/start" method="post">
            <Button type="submit" disabled={!available} className={`${buttonClass} bg-lsr-orange text-white hover:bg-white hover:text-lsr-charcoal`}>
              Link Discord
            </Button>
          </form>
        </div>
      )}
      <p className="font-sans text-xs leading-relaxed text-white/45">
        Linking shares only your Discord user ID and username with us. We throw Discord&apos;s access token away right after, so it gives us no access to your
        account, your DMs or other servers.{' '}
        <Link href="/privacy#discord" className="text-white/70 underline-offset-2 hover:text-lsr-orange hover:underline">
          What the club&apos;s Discord bot reads
        </Link>
      </p>
    </div>
  );
}
