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
 * moments rather than a single album: each album's first landscape photo, else its first photo,
 * skipping the photo /gallery uses as its hero.
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
  const isLandscape = (image: { width: number | null; height: number | null }) => !!image.width && !!image.height && image.width > image.height;
  // The /gallery hero: the first landscape photo across the newest albums (see gallery/page.tsx)
  const heroId = newest.flatMap((album) => album.images).find(isLandscape)?.id;
  return newest.map((album) => {
    const others = album.images.filter((image) => image.id !== heroId);
    const photo = others.find(isLandscape) ?? others[0] ?? album.images[0];
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
