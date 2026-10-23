// News posts: create and update, with their tags. Used by the admin news actions
// (src/server/actions/news.ts) and by Jack's news.create / news.update proposals.
//
// - Callers check permissions first (the admin actions keep requireRole()); services validate the post
//   again and return { ok: false, error } instead of throwing, for a bad post, a taken slug or a failed
//   save.
// - Services don't refresh pages: revalidatePath only works inside a request. A successful result lists
//   the paths it touched in `revalidate`; the caller passes them to revalidatePaths()
//   (src/server/cache/revalidate-public.ts), so the admin page and a proposal refresh the same pages.

import { Prisma, type Post } from "@prisma/client";
import { prisma } from "@/server/db";
import { newsPostSchema, type NewsPostSchema } from "@/schemas/news.schema";
import { slugify } from "@/lib/slug";
import { createAuditLog } from "@/server/audit/log";
import { publicPaths } from "@/server/cache/revalidate-public";
import { withActorMetadata, type ServiceActor } from "@/server/services/actor";

const ADMIN_NEWS = "/admin/news";

export type NewsPostResult = { ok: true; post: Post; revalidate: string[] } | { ok: false; error: string };

function invalid(error: { issues: { message: string }[] }) {
  return { ok: false as const, error: error.issues.map((issue) => issue.message).join(". ") };
}

// Prisma's own export, not the class in @prisma/client/runtime/library: imported as ESM, that path loads
// a second copy of the runtime, and the client's errors aren't instances of its class
function slugTaken(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Tags the post, creating tags that don't exist yet */
async function addTags(postId: string, tags: string[]) {
  for (const tagName of tags) {
    const tagSlug = slugify(tagName);
    let tag = await prisma.tag.findUnique({ where: { slug: tagSlug } });
    if (!tag) {
      tag = await prisma.tag.create({ data: { name: tagName, slug: tagSlug } });
    }
    await prisma.entityTag.create({
      data: {
        tagId: tag.id,
        entityType: "post",
        entityId: postId,
      },
    });
  }
}

/**
 * Creates a post. `publishedAt` null keeps it a draft; a future date schedules it. If tagging fails after
 * the post is saved, the post stays and the result is still an error (as the admin page has always done).
 */
export async function createPost(input: NewsPostSchema, actor: ServiceActor): Promise<NewsPostResult> {
  const parsed = newsPostSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const validated = parsed.data;

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
      actorUserId: actor.userId,
      actionType: "CREATE",
      entityType: "POST",
      entityId: post.id,
      summary: `Created news post: ${post.title}`,
      after: { title: post.title, slug: post.slug },
      metadata: withActorMetadata(actor),
    });

    if (validated.tags && validated.tags.length > 0) {
      await addTags(post.id, validated.tags);
    }

    return { ok: true, post, revalidate: [ADMIN_NEWS, publicPaths.news] };
  } catch (error) {
    if (slugTaken(error)) return { ok: false, error: "Slug already exists" };
    return { ok: false, error: "Failed to create post" };
  }
}

/**
 * Replaces a post's fields and tags with `input` (every field, as the admin form sends them). A slug
 * change refreshes the old address too.
 */
export async function updatePost(id: string, input: NewsPostSchema, actor: ServiceActor): Promise<NewsPostResult> {
  const parsed = newsPostSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const validated = parsed.data;

  const existingPost = await prisma.post.findUnique({ where: { id } });
  if (!existingPost) {
    return { ok: false, error: "Post not found" };
  }

  try {
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
      actorUserId: actor.userId,
      actionType: "UPDATE",
      entityType: "POST",
      entityId: post.id,
      summary: `Updated news post: ${post.title}`,
      after: { title: post.title, slug: post.slug },
      metadata: withActorMetadata(actor),
    });

    // Sync tags: remove them all, then add the selected ones
    await prisma.entityTag.deleteMany({
      where: { entityType: "post", entityId: id },
    });
    if (validated.tags && validated.tags.length > 0) {
      await addTags(post.id, validated.tags);
    }

    return {
      ok: true,
      post,
      revalidate: [
        ADMIN_NEWS,
        publicPaths.news,
        ...(post.slug !== existingPost.slug ? [publicPaths.newsPost(existingPost.slug)] : []),
        publicPaths.newsPost(post.slug),
      ],
    };
  } catch (error) {
    if (slugTaken(error)) return { ok: false, error: "Slug already exists" };
    return { ok: false, error: "Failed to update post" };
  }
}
