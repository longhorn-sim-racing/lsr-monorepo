import { prisma } from "@/server/db";

export async function getAllGalleryImages() {
  return prisma.galleryImage.findMany({
    orderBy: {
      order: 'asc',
    },
  });
}

/** Albums that have photos, newest first, each with its photos in display order. */
export async function getGalleryAlbums() {
  return prisma.galleryAlbum.findMany({
    where: { images: { some: {} } },
    orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    include: {
      images: { orderBy: { order: "asc" } },
      event: { select: { slug: true, status: true, visibility: true, publishedAt: true } },
    },
  });
}

/** Photos not in any album yet. */
export async function getUnsortedGalleryImages() {
  return prisma.galleryImage.findMany({
    where: { albumId: null },
    orderBy: { order: "asc" },
  });
}
