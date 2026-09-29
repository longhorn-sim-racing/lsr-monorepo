import { getAllPostsForAdmin } from "@/server/queries/news";
import { NewsConsole } from "@/components/admin/news-console";
import { requireOfficerPage } from "@/server/auth/guards";

export default async function AdminNewsPage() {
  await requireOfficerPage();
  const posts = await getAllPostsForAdmin();

  return (
    <div className="h-full">
      <NewsConsole initialPosts={posts} />
    </div>
  );
}