import { prisma } from "@/server/db"
import { PostForm } from "../_components/post-form"
import { requireOfficerPage } from "@/server/auth/guards";

export default async function NewPostPage() {
  await requireOfficerPage();
  const users = await prisma.user.findMany({
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' }
  });

  const tags = await prisma.tag.findMany({
    select: { name: true },
    orderBy: { name: 'asc' }
  });

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-3xl font-bold mb-8">Create New Post</h1>
      <PostForm 
        users={users} 
        availableTags={tags.map(t => t.name)}
      />
    </div>
  )
}