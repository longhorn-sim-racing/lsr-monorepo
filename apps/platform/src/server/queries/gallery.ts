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

/** A handful of recent photos for the homepage ribbon: newest albums first. */
export async function getFeaturedGalleryImages(limit = 12) {
  return prisma.galleryImage.findMany({
    orderBy: [{ album: { date: { sort: "desc", nulls: "last" } } }, { order: "asc" }],
    take: limit,
  });
}

/** The newest album with its first photo, for teaser cards. */
export async function getLatestGalleryAlbum() {
  return prisma.galleryAlbum.findFirst({
    where: { images: { some: {} } },
    orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    include: { images: { orderBy: { order: "asc" }, take: 1 } },
  });
}
