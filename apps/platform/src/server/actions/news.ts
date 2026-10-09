'use server';

import { prisma } from '@/server/db';
import { requireRole } from '@/server/auth/guards';
import { newsPostSchema, NewsPostSchema } from '@/schemas/news.schema';
import { revalidatePath } from 'next/cache';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { slugify } from '@/lib/slug';
import { createAuditLog } from '@/server/audit/log';
import { getSessionUser } from '@/server/auth/session';

export async function createPost(data: NewsPostSchema) {
  await requireRole(['admin', 'officer']);
  
  const validated = newsPostSchema.parse(data);
  const { user } = await getSessionUser();
  if (!user) throw new Error("Unauthorized");

  try {
    const post = await prisma.post.create({
      data: {
        title: validated.title,
        slug: validated.slug,
        excerpt: validated.excerpt,
        coverImageUrl: validated.coverImageUrl ?? null,
        bodyMd: validated.bodyMd,
        publishedAt: validated.publishedAt,
        authorId: validated.authorId,
      },
    });

    await createAuditLog({
      actorUserId: user.id,
      actionType: "CREATE",
      entityType: "POST",
      entityId: post.id,
      summary: `Created news post: ${post.title}`,
      after: { title: post.title, slug: post.slug },
    });

    // Handle Tags
    if (validated.tags && validated.tags.length > 0) {
      for (const tagName of validated.tags) {
        const tagSlug = slugify(tagName);
        let tag = await prisma.tag.findUnique({ where: { slug: tagSlug } });
        if (!tag) {
          tag = await prisma.tag.create({ data: { name: tagName, slug: tagSlug } });
        }
        await prisma.entityTag.create({
          data: {
            tagId: tag.id,
            entityType: 'post',
            entityId: post.id,
          },
        });
      }
    }

    revalidatePath('/admin/news');
    revalidatePath('/news');
    return { success: true, post };
  } catch (error) {
    if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
      return { success: false, error: 'Slug already exists' };
    }
    return { success: false, error: 'Failed to create post' };
  }
}

export async function updatePost(id: string, data: NewsPostSchema) {
  await requireRole(['admin', 'officer']);
  const { user } = await getSessionUser();
  if (!user) throw new Error("Unauthorized");

  const validated = newsPostSchema.parse(data);

  const existingPost = await prisma.post.findUnique({ where: { id } });
  if (!existingPost) {
    return { success: false, error: 'Post not found' };
  }

  try {
    // Update Post fields
    const post = await prisma.post.update({
      where: { id },
      data: {
        title: validated.title,
        slug: validated.slug,
        excerpt: validated.excerpt,
        coverImageUrl: validated.coverImageUrl ?? null,
        bodyMd: validated.bodyMd,
        publishedAt: validated.publishedAt,
        authorId: validated.authorId,
      },
    });

    await createAuditLog({
      actorUserId: user.id,
      actionType: "UPDATE",
      entityType: "POST",
      entityId: post.id,
      summary: `Updated news post: ${post.title}`,
      after: { title: post.title, slug: post.slug },
    });

    // Handle Tags (Sync)
    // First, remove all existing tags for this post
    await prisma.entityTag.deleteMany({
      where: { entityType: 'post', entityId: id },
    });

    // Then re-add selected tags
    if (validated.tags && validated.tags.length > 0) {
        for (const tagName of validated.tags) {
          const tagSlug = slugify(tagName);
          let tag = await prisma.tag.findUnique({ where: { slug: tagSlug } });
          if (!tag) {
            tag = await prisma.tag.create({ data: { name: tagName, slug: tagSlug } });
          }
          await prisma.entityTag.create({
            data: {
              tagId: tag.id,
              entityType: 'post',
              entityId: post.id,
            },
          });
        }
    }

    revalidatePath('/admin/news');
    revalidatePath('/news');
    if (post.slug !== existingPost.slug) {
        revalidatePath(`/news/${existingPost.slug}`);
    }
    revalidatePath(`/news/${post.slug}`);
    
    return { success: true, post };
  } catch (error) {
    if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
      return { success: false, error: 'Slug already exists' };
    }
    return { success: false, error: 'Failed to update post' };
  }
}