/**
 * Bulk-import photos into gallery albums: uploads each file to Cloudinary (signed) and
 * creates the GalleryAlbum / GalleryImage rows. Safe to re-run: albums are matched by slug
 * and photos by Cloudinary public id, so anything already imported is skipped.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/gallery-import.ts <manifest.json> [--dry-run]
 *
 * Needs DATABASE_URL, NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and
 * CLOUDINARY_API_SECRET in the environment. The manifest looks like:
 *
 *   {
 *     "albums": [{ "slug": "cota-track-day", "title": "COTA Track Day", "date": "2026-02-15", "description": null }],
 *     "photos": [{ "album": "cota-track-day", "file": "C:/photos/img-1049.jpg", "width": 2400, "height": 1600,
 *                  "alt": null, "creditName": null, "creditUrl": null }]
 *   }
 *
 * Photos keep the manifest's order within each album. Resize them first (2400px on the long
 * edge is plenty); Cloudinary serves smaller versions on demand.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { PrismaClient } from "@prisma/client";

type ManifestAlbum = { slug: string; title: string; date: string | null; description?: string | null };
type ManifestPhoto = {
  album: string;
  file: string;
  width?: number;
  height?: number;
  alt?: string | null;
  creditName?: string | null;
  creditUrl?: string | null;
};

const [manifestPath, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!manifestPath) {
  console.error("Usage: tsx scripts/gallery-import.ts <manifest.json> [--dry-run]");
  process.exit(1);
}

const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
if (!cloud || !apiKey || !apiSecret || !process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL, NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY or CLOUDINARY_API_SECRET");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { albums: ManifestAlbum[]; photos: ManifestPhoto[] };
const prisma = new PrismaClient();

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Signed upload; with overwrite=false Cloudinary returns the existing asset if the id is taken. */
async function upload(file: string, publicId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = { overwrite: "false", public_id: publicId, timestamp: String(timestamp) };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const signature = createHash("sha1").update(toSign + apiSecret).digest("hex");

  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("api_key", apiKey!);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: "POST", body: form });
  const json = (await res.json()) as { public_id?: string; width?: number; height?: number; error?: { message: string } };
  if (!res.ok || !json.public_id) throw new Error(json.error?.message ?? `Upload failed (${res.status})`);
  return { publicId: json.public_id, width: json.width ?? null, height: json.height ?? null };
}

async function main() {
  const albumIds = new Map<string, string>();
  for (const album of manifest.albums) {
    const data = {
      title: album.title,
      date: album.date ? new Date(`${album.date}T12:00:00Z`) : null,
      description: album.description ?? null,
    };
    if (dryRun) {
      console.log(`[dry-run] album ${album.slug}: ${album.title}`);
      continue;
    }
    const row = await prisma.galleryAlbum.upsert({ where: { slug: album.slug }, update: {}, create: { slug: album.slug, ...data } });
    albumIds.set(album.slug, row.id);
  }

  const orderInAlbum = new Map<string, number>();
  let created = 0;
  let skipped = 0;
  for (const photo of manifest.photos) {
    const order = (orderInAlbum.get(photo.album) ?? 0) + 1;
    orderInAlbum.set(photo.album, order);
    const publicId = `gallery/${photo.album}/${slugify(basename(photo.file, extname(photo.file)))}`;

    if (await prisma.galleryImage.findUnique({ where: { publicId } })) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${publicId} <- ${photo.file}`);
      continue;
    }
    const albumId = albumIds.get(photo.album);
    if (!albumId) throw new Error(`Photo ${photo.file} names unknown album ${photo.album}`);

    const uploaded = await upload(photo.file, publicId);
    await prisma.galleryImage.create({
      data: {
        publicId: uploaded.publicId,
        albumId,
        order,
        width: uploaded.width ?? photo.width ?? null,
        height: uploaded.height ?? photo.height ?? null,
        alt: photo.alt ?? null,
        creditName: photo.creditName ?? null,
        creditUrl: photo.creditUrl ?? null,
      },
    });
    created++;
    if (created % 10 === 0) console.log(`  ${created} uploaded...`);
  }
  console.log(`Done: ${created} photos added, ${skipped} already there.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
