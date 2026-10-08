'use server';

import { prisma } from '@/server/db';
import { revalidatePath } from 'next/cache';
import { requireOfficer } from '@/server/auth/guards';
import { createAuditLog } from '@/server/audit/log';

function revalidateGallery() {
  revalidatePath('/admin/gallery');
  revalidatePath('/gallery');
  revalidatePath('/');
}

/** Next order value at the end of an album (or of the unsorted photos). */
async function nextOrder(albumId: string | null) {
  const last = await prisma.galleryImage.aggregate({ where: { albumId }, _max: { order: true } });
  return (last._max.order ?? 0) + 1;
}

export async function createImage(
  publicId: string,
  { albumId = null, width = null, height = null }: { albumId?: string | null; width?: number | null; height?: number | null } = {},
) {
  const user = await requireOfficer();

  const newImage = await prisma.galleryImage.create({
    data: { publicId, albumId, width, height, order: await nextOrder(albumId) },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "GALLERY_IMAGE",
    entityId: newImage.id,
    summary: `Uploaded gallery image ${publicId}`,
    metadata: { albumId },
  });

  revalidateGallery();
  return newImage;
}

export async function updateImageOrder(images: { id: string; order: number }[]) {
  const user = await requireOfficer();

  const transactions = images.map((image) =>
    prisma.galleryImage.update({
      where: { id: image.id },
      data: { order: image.order },
    }),
  );
  await prisma.$transaction(transactions);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "GALLERY_IMAGE",
    entityId: "BATCH",
    summary: `Reordered ${images.length} gallery images`,
    metadata: { count: images.length },
  });

  revalidateGallery();
}

export async function deleteImage(id: string) {
  const user = await requireOfficer();

  await prisma.galleryImage.delete({ where: { id } });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "GALLERY_IMAGE",
    entityId: id,
    summary: `Deleted gallery image ${id}`,
  });

  revalidateGallery();
}

export async function updateImageCredit(id: string, creditName: string | null, creditUrl: string | null) {
  const user = await requireOfficer();

  await prisma.galleryImage.update({
    where: { id },
    data: { creditName, creditUrl },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "GALLERY_IMAGE",
    entityId: id,
    summary: `Updated credit for gallery image ${id}`,
    after: { creditName, creditUrl },
  });

  revalidateGallery();
}

/** Moves a photo into an album (or back to unsorted with null), at the end of it. */
export async function moveImageToAlbum(id: string, albumId: string | null) {
  const user = await requireOfficer();

  const image = await prisma.galleryImage.update({
    where: { id },
    data: { albumId, order: await nextOrder(albumId) },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "GALLERY_IMAGE",
    entityId: id,
    summary: albumId ? `Moved gallery image to album ${albumId}` : `Moved gallery image out of its album`,
    after: { albumId },
  });

  revalidateGallery();
  return image;
}

// --- Albums ---

export type AlbumInput = {
  title: string;
  date: string | null; // yyyy-mm-dd
  description: string | null;
  eventId: string | null;
};

function slugify(title: string) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 60) || "album";
}

async function uniqueSlug(title: string, excludeId?: string) {
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = await prisma.galleryAlbum.findFirst({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (!taken) return slug;
  }
}

function parseAlbumInput(input: AlbumInput) {
  const title = input.title.trim();
  if (!title) throw new Error("Album title is required");
  // Noon UTC so the month shown in Austin matches the date picked
  const date = input.date ? new Date(`${input.date}T12:00:00Z`) : null;
  if (date && Number.isNaN(date.getTime())) throw new Error("Invalid album date");
  return {
    title,
    date,
    description: input.description?.trim() || null,
    eventId: input.eventId || null,
  };
}

export async function createAlbum(input: AlbumInput) {
  const user = await requireOfficer();
  const data = parseAlbumInput(input);

  const album = await prisma.galleryAlbum.create({
    data: { ...data, slug: await uniqueSlug(data.title) },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "GALLERY_ALBUM",
    entityId: album.id,
    summary: `Created gallery album "${album.title}"`,
    after: album,
  });

  revalidateGallery();
  return album;
}

export async function updateAlbum(id: string, input: AlbumInput) {
  const user = await requireOfficer();
  const data = parseAlbumInput(input);

  const before = await prisma.galleryAlbum.findUniqueOrThrow({ where: { id } });
  const album = await prisma.galleryAlbum.update({
    where: { id },
    // Keep the slug (and shared links) unless the title changed
    data: { ...data, slug: data.title === before.title ? before.slug : await uniqueSlug(data.title, id) },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "GALLERY_ALBUM",
    entityId: id,
    summary: `Updated gallery album "${album.title}"`,
    before,
    after: album,
  });

  revalidateGallery();
  return album;
}

/** Deletes the album; its photos stay and become unsorted. */
export async function deleteAlbum(id: string) {
  const user = await requireOfficer();

  const album = await prisma.galleryAlbum.delete({ where: { id } });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "GALLERY_ALBUM",
    entityId: id,
    summary: `Deleted gallery album "${album.title}" (photos kept as unsorted)`,
    before: album,
  });

  revalidateGallery();
}

/** Sets the same photo credit on every photo in an album. */
export async function setAlbumCredit(albumId: string, creditName: string | null, creditUrl: string | null) {
  const user = await requireOfficer();

  const { count } = await prisma.galleryImage.updateMany({
    where: { albumId },
    data: { creditName: creditName?.trim() || null, creditUrl: creditUrl?.trim() || null },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "GALLERY_ALBUM",
    entityId: albumId,
    summary: `Set photo credit on ${count} photos in album ${albumId}`,
    after: { creditName, creditUrl },
  });

  revalidateGallery();
  return count;
}
