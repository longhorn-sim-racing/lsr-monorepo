'use server';

import { prisma } from '@/server/db';
import { requireUser } from '@/server/auth/guards';
import { unlinkDiscord } from '@/server/services/discord-link.service';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function updateMarketingOptIn(formData: FormData) {
  const user = await requireUser();
  const val = formData.get('marketingOptIn');
  const checked = val === 'on' || val === 'true' || val === '1';

  await prisma.user.update({
    where: { id: user.id },
    data: { marketingOptIn: checked },
  });

  revalidatePath('/account');
}

export async function updateNotificationPreferences(formData: FormData) {
  const user = await requireUser();

  const emailRegistration = formData.get('emailRegistration') === 'on';
  const emailWaitlistPromotion = formData.get('emailWaitlistPromotion') === 'on';
  const emailEventReminder = formData.get('emailEventReminder') === 'on';
  const emailEventPosted = formData.get('emailEventPosted') === 'on';
  const emailResultsPosted = formData.get('emailResultsPosted') === 'on';

  await prisma.notificationPreference.upsert({
    where: { userId: user.id },
    update: {
      emailRegistration,
      emailWaitlistPromotion,
      emailEventReminder,
      emailEventPosted,
      emailResultsPosted,
    },
    create: {
      userId: user.id,
      emailRegistration,
      emailWaitlistPromotion,
      emailEventReminder,
      emailEventPosted,
      emailResultsPosted,
    },
  });

  revalidatePath('/account');
}

export async function retireAccount() {
  const user = await requireUser();

  await prisma.user.update({
    where: { id: user.id },
    data: { status: 'retired' },
  });

  redirect('/account/retired');
}

export async function deleteAccount() {
  const user = await requireUser();

  // The Discord link goes with the account, and so does every Discord row that pointed at it
  await unlinkDiscord(user.id);
  await prisma.$transaction(async (tx) => {
    // Jack's room messages keep who posted them as a label (name, title, major, handle): it goes with the account
    await tx.jackMessage.updateMany({ where: { authorUserId: user.id }, data: { authorLabel: null } });
    // Resend's delivery events for mail to them (their address, bounces): by address, and by the club's emails
    // to them, read before those rows go with the account (an application email may have gone to another address)
    const [notifications, applicationEmails] = await Promise.all([
      tx.notification.findMany({ where: { userId: user.id, emailMessageId: { not: null } }, select: { emailMessageId: true } }),
      tx.applicationEmail.findMany({ where: { application: { userId: user.id }, resendMessageId: { not: null } }, select: { resendMessageId: true } }),
    ]);
    const resendIds = [...notifications.map((n) => n.emailMessageId), ...applicationEmails.map((e) => e.resendMessageId)].filter((id): id is string => !!id);
    await tx.emailEvent.deleteMany({
      where: { OR: [{ recipient: user.email.trim().toLowerCase() }, ...(resendIds.length ? [{ resendId: { in: resendIds } }] : [])] },
    });
    await tx.user.delete({ where: { id: user.id } });
  }, { timeout: 30_000 });

  redirect('/?account=deleted');
}

