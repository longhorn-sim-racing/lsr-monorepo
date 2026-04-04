'use server';

import { z } from 'zod';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/auth/guards';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

// Schema shared by the action
const UserSchema = z.object({
  displayName: z.string().min(2).max(80),
  iRating: z.union([z.string(), z.number()]).optional().transform(v => {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    return Number.isFinite(n as number) ? Number(n) : null;
  }),
  racingNumber: z.union([z.string(), z.number()]).optional().transform(v => {
    if (v === '' || v === undefined || v === null) return null;
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    return Number.isFinite(n as number) ? Number(n) : null;
  }),
  bio: z.string().max(2000).optional().nullable(),
  gradYear: z.union([z.string(), z.number()]).optional().transform(v => {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    return Number.isFinite(n as number) ? Number(n) : null;
  }),
  major: z.string().max(100).optional().nullable(),
  website: z.string().url().optional().or(z.literal('')).transform(v => v || null),
  instagram: z.string().url().optional().or(z.literal('')).transform(v => v || null),
  twitch: z.string().url().optional().or(z.literal('')).transform(v => v || null),
  youtube: z.string().url().optional().or(z.literal('')).transform(v => v || null),
});






import { getLeorgeGawrenceEnforcementUnitStatus } from '@/app/admin/tools/actions';

// ----- SERVER ACTION (single-arg shape for <form action={...}>) -----
export async function updateProfile(formData: FormData) {
  const user = await requireUser();

  const parsed = UserSchema.safeParse({
    displayName: formData.get('displayName'),
    iRating: formData.get('iRating'),
    racingNumber: formData.get('racingNumber'),
    bio: formData.get('bio'),
    gradYear: formData.get('gradYear'),
    major: formData.get('major'),
    website: formData.get('website'),
    instagram: formData.get('instagram'),
    twitch: formData.get('twitch'),
    youtube: formData.get('youtube'),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.flatten().formErrors.join(', ') || 'Invalid input.');
  }

  if (parsed.data.racingNumber !== null) {
    const existing = await prisma.user.findUnique({
      where: { racingNumber: parsed.data.racingNumber },
      select: { id: true }
    });
    if (existing && existing.id !== user.id) {
      throw new Error('This racing number is already reserved by another driver.');
    }
  }

  const isEnforced = await getLeorgeGawrenceEnforcementUnitStatus();
  const targetUserId = '7c902926-806f-4de1-95fe-6dbbe7b339e3'; // Replace with target
  const enforcedName = 'Leorge Gawrence';

  let displayName = parsed.data.displayName;
  if (isEnforced && user.id === targetUserId) {
    displayName = enforcedName;
  }

  const prevSocials = (user.socials as Record<string, string> | null) ?? {};
  await prisma.user.update({
    where: { id: user.id },
    data: {
      displayName: displayName,
      iRating: parsed.data.iRating ?? undefined,
      racingNumber: parsed.data.racingNumber !== undefined ? parsed.data.racingNumber : undefined,
      bio: parsed.data.bio ?? undefined,
      gradYear: parsed.data.gradYear ?? undefined,
      major: parsed.data.major ?? undefined,
      socials: {
        ...prevSocials,
        website: parsed.data.website,
        instagram: parsed.data.instagram,
        twitch: parsed.data.twitch,
        youtube: parsed.data.youtube,
      },
    },
  });

  revalidatePath(`/drivers/${user.handle}`);
  redirect(`/drivers/${user.handle}`);
}

export async function saveAvatar(url: string) {
  const user = await requireUser();

  try {
    await prisma.$connect();
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: url },
    });
  } finally {
    await prisma.$disconnect();
  }

  revalidatePath(`/drivers/${user.handle}`);
}

export async function clearAvatar() {
  const user = await requireUser();

  try {
    await prisma.$connect();
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: null },
    });
  } finally {
    await prisma.$disconnect();
  }


  revalidatePath(`/drivers/${user.handle}`);
}

