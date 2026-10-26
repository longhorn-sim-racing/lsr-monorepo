'use server';

import { z } from 'zod';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/auth/guards';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { revalidateDriverList } from '@/server/cache/revalidate-public';
import type { ActionResult } from '@/lib/action-result';
import { eidInputSchema } from '@/schemas/eid.schema';
import { EID_TAKEN, setUserEid } from '@/server/services/eid.service';
import { officerProfileFromForm, officerProfileSchema, type OfficerProfile } from '@/schemas/officer-profile.schema';

// Schema shared by the action
const UserSchema = z.object({
  displayName: z.string().min(2).max(80),
  iRating: z.union([z.string(), z.number()]).optional().transform(v => {
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

  // Officers also edit their officer profile here (the form shows that step only to them)
  const isOfficer = (await prisma.userRole.count({ where: { userId: user.id, role: { key: { in: ['officer', 'admin'] } } } })) > 0;
  let officerProfile: OfficerProfile | null = null;
  if (isOfficer && formData.has('department')) {
    const profile = officerProfileSchema.safeParse(officerProfileFromForm(formData));
    if (!profile.success) throw new Error(profile.error.issues[0]?.message ?? 'Check your officer profile.');
    officerProfile = profile.data;
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
      ...(officerProfile ?? {}),
    },
  });

  revalidatePath(`/drivers/${user.handle}`);
  revalidateDriverList();
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
  revalidateDriverList();
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
  revalidateDriverList();
}

/** Saves (or, when blank, removes) the signed-in user's UT EID. Returns the stored value. */
export async function saveEid(value: string): Promise<ActionResult<string | null>> {
  const user = await requireUser();

  const parsed = eidInputSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That UT EID doesn't look right." };
  }

  const eid = parsed.data;
  if (eid === user.eid) return { ok: true, data: eid };
  if ((await setUserEid(user.id, eid)) === 'taken') {
    return { ok: false, error: `${EID_TAKEN} If it's yours, email info@longhornsimracing.org and we'll sort it out.` };
  }

  revalidatePath('/account');
  revalidatePath(`/drivers/${user.handle}/edit`);
  return { ok: true, data: eid };
}
