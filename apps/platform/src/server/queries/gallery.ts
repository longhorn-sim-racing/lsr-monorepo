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

/**
 * One photo from each of the newest albums, for the homepage strip, so it shows a mix of club
 * moments rather than a single album: each album's first landscape photo, else its first photo.
 * The newest album's first landscape photo is the /gallery hero, so that album uses its second.
 */
export async function getGalleryHighlights(albums = 5) {
  const newest = await prisma.galleryAlbum.findMany({
    where: { images: { some: {} } },
    orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: albums,
    select: {
      slug: true,
      title: true,
      images: {
        orderBy: { order: "asc" },
        take: 12,
        select: { id: true, publicId: true, alt: true, width: true, height: true, creditName: true },
      },
    },
  });
  return newest.map((album, i) => {
    const landscape = album.images.filter((image) => image.width && image.height && image.width > image.height);
    const photo = (i === 0 ? landscape[1] : undefined) ?? landscape[0] ?? album.images[0];
    return { ...photo, album: album.slug, albumTitle: album.title };
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
