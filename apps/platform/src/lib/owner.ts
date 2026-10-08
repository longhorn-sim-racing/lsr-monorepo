import { getSessionUser } from '@/server/auth/session';

// Returns { isOwner, userId } for current session
export async function getOwnerStatus(targetUserId: string) {
  const { user } = await getSessionUser();
  const userId = user?.id ?? null;
  return { isOwner: !!userId && userId === targetUserId, userId };
}
