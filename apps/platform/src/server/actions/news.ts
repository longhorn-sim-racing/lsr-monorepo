'use server';

import { requireRole } from '@/server/auth/guards';
import { newsPostSchema, NewsPostSchema } from '@/schemas/news.schema';
import { getSessionUser } from '@/server/auth/session';
import { revalidatePaths } from '@/server/cache/revalidate-public';
import * as news from '@/server/services/news.service';

export async function createPost(data: NewsPostSchema) {
  await requireRole(['admin', 'officer']);

  const validated = newsPostSchema.parse(data);
  const { user } = await getSessionUser();
  if (!user) throw new Error("Unauthorized");

  const result = await news.createPost(validated, { userId: user.id });
  if (!result.ok) return { success: false, error: result.error };

  revalidatePaths(result.revalidate);
  return { success: true, post: result.post };
}

export async function updatePost(id: string, data: NewsPostSchema) {
  await requireRole(['admin', 'officer']);
  const { user } = await getSessionUser();
  if (!user) throw new Error("Unauthorized");

  const validated = newsPostSchema.parse(data);

  const result = await news.updatePost(id, validated, { userId: user.id });
  if (!result.ok) return { success: false, error: result.error };

  revalidatePaths(result.revalidate);
  return { success: true, post: result.post };
}
