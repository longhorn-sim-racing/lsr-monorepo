// src/server/auth/session.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { User } from '@prisma/client';
import { slugify } from '@/lib/slug';
import { revalidateDriverList } from '@/server/cache/revalidate-public';

export type SessionUser = {
  user: (User & { roles: { role: { key: string } }[] }) | null;
  roles: string[];
};

async function provisionUser(authUser: any) {
  return prisma.$transaction(async (tx) => {
    // Double-check inside transaction to prevent race conditions
    const existingUser = await tx.user.findUnique({ where: { id: authUser.id } });
    if (existingUser) return existingUser;

    if (!authUser.email) {
      throw new Error('User email is missing from Supabase data.');
    }

    const displayName = authUser.user_metadata.full_name || authUser.user_metadata.displayName || authUser.email.split('@')[0];

    // Create a unique handle, appending a number if necessary
    const baseHandle = slugify(displayName);
    let finalHandle = baseHandle;
    let counter = 1;
    while (await tx.user.findUnique({ where: { handle: finalHandle } })) {
      finalHandle = `${baseHandle}-${counter}`;
      counter++;
    }

    const newUserPayload = {
      id: authUser.id,
      email: authUser.email,
      handle: finalHandle,
      displayName: displayName,
      avatarUrl: authUser.user_metadata.avatar_url,
      status: 'active' as const,
      marketingOptIn: authUser.user_metadata.marketingOptIn ?? true,
    };

    return tx.user.create({ data: newUserPayload });
  });
}

export async function getSessionUser(): Promise<SessionUser> {
  const cookieStore = await cookies(); // await is necessary here for read-only contexts
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
      },
    },
  );

  let authUser;
  try {
    const { data } = await supabase.auth.getUser();
    authUser = data.user;
  } catch (error) {
    console.error('[getSessionUser] Supabase auth unreachable:', error);
    return { user: null, roles: [] };
  }

  if (!authUser) {
    return { user: null, roles: [] };
  }

  let dbUser = await prisma.user.findUnique({
    where: { id: authUser.id },
    include: {
      roles: {
        include: {
          role: {
            select: { key: true },
          },
        },
      },
    },
  });

  if (!dbUser) {
    // JIT Provisioning: Supabase user exists but Prisma user does not.
    try {
      await provisionUser(authUser);
      // Re-fetch to match the expected return type with relations
      dbUser = await prisma.user.findUnique({
        where: { id: authUser.id },
        include: {
          roles: {
            include: {
              role: {
                select: { key: true },
              },
            },
          },
        },
      });
      // New driver joined the roster — bust the cached /drivers page.
      if (dbUser) revalidateDriverList();
    } catch (error) {
      console.error('[getSessionUser] Failed to provision missing user:', error);
      // Fallthrough to return null
    }
  }

  if (!dbUser) {
    return { user: null, roles: [] };
  }

  return {
    user: dbUser,
    roles: dbUser.roles.map(r => r.role.key),
  };
}