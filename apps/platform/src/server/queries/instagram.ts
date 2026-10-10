import { prisma } from "@/server/db"

/** Instagram posts for public pages: newest first, skipping hidden ones and any whose image didn't copy. */
export async function getInstagramFeed(limit = 8) {
  return prisma.instagramPost.findMany({
    where: { hidden: false, publicId: { not: null } },
    orderBy: { postedAt: "desc" },
    take: limit,
  })
}

/** Recent posts for the admin page, hidden ones included. */
export async function getInstagramPostsForAdmin(limit = 48) {
  return prisma.instagramPost.findMany({ orderBy: { postedAt: "desc" }, take: limit })
}
