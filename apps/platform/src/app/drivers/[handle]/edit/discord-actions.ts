'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/server/auth/guards';
import { unlinkDiscord } from '@/server/services/discord-link.service';

/** Removes the member's own Discord link (design §12.1: relinking needs an unlink first). Works whether or not Discord is connected */
export async function unlinkDiscordAction() {
  const user = await requireUser();
  await unlinkDiscord(user.id);
  revalidatePath(`/drivers/${user.handle}/edit`);
  redirect(`/drivers/${encodeURIComponent(user.handle)}/edit?discord=unlinked#discord`);
}
