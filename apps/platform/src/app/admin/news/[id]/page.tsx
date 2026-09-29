import { notFound } from "next/navigation"
import { prisma } from "@/server/db"
import { PostForm } from "../_components/post-form"
import { requireOfficerPage } from "@/server/auth/guards";

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditPostPage({ params }: PageProps) {
  await requireOfficerPage();
  const { id } = await params
  
  // Fetch post with relational data (tags via EntityTag)
  const post = await prisma.post.findUnique({
    where: { id },
  })

  if (!post) {
    notFound()
  }

  // Fetch tags for this post
  const entityTags = await prisma.entityTag.findMany({
    where: { entityType: 'post', entityId: id },
    include: { tag: true }
  });
  const postTags = entityTags.map(et => et.tag.name);

  // Fetch data for dropdowns
  const users = await prisma.user.findMany({
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' }
  });

  const tags = await prisma.tag.findMany({
    select: { name: true },
    orderBy: { name: 'asc' }
  });

  // Transform to schema shape
  const postData = {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt ?? "",
    bodyMd: post.bodyMd,
    authorId: post.authorId ?? "",
    publishedAt: post.publishedAt,
    tags: postTags,
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-3xl font-bold mb-8">Edit Post</h1>
      <PostForm 
        post={postData} 
        users={users}
        availableTags={tags.map(t => t.name)}
      />
    </div>
  )
}