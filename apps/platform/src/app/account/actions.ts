'use server';

import { prisma } from '@/server/db';
import { requireUser } from '@/server/auth/guards';
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

  // Jack's room messages keep who posted them as a label (name, title, major, handle): it goes with the account
  await prisma.$transaction([
    prisma.jackMessage.updateMany({ where: { authorUserId: user.id }, data: { authorLabel: null } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);

  redirect('/?account=deleted');
}

