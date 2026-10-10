/**
 * Bulk-import photos into gallery albums: uploads each file to Cloudinary (signed) and
 * creates the GalleryAlbum / GalleryImage rows. Safe to re-run: albums are matched by slug
 * and photos by Cloudinary public id, so anything already imported is skipped.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/gallery-import.ts <manifest.json> [--dry-run] [--yes]
 *
 * It prints the database host first and refuses to write to anything but a local database
 * unless you pass --yes.
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
 * A photo that's already in Cloudinary can be listed with "publicId" (plus width/height)
 * instead of "file"; it's linked into the album without uploading again.
 *
 * Photos keep the manifest's order within each album. Resize them first (2400px on the long
 * edge is plenty); Cloudinary serves smaller versions on demand.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { PrismaClient } from "@prisma/client";

type ManifestAlbum = { slug: string; title: string; date: string | null; description?: string | null };
type ManifestPhoto = {
  album: string;
  /** Local file to upload, or */
  file?: string;
  /** an image already in Cloudinary */
  publicId?: string;
  width?: number;
  height?: number;
  alt?: string | null;
  creditName?: string | null;
  creditUrl?: string | null;
};

const [manifestPath, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const confirmed = flags.includes("--yes");
if (!manifestPath) {
  console.error("Usage: tsx scripts/gallery-import.ts <manifest.json> [--dry-run] [--yes]");
  process.exit(1);
}

const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
if (!cloud || !apiKey || !apiSecret || !process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL, NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY or CLOUDINARY_API_SECRET");
  process.exit(1);
}

const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL!).hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
})();
const isLocalDb = ["127.0.0.1", "localhost", "::1"].includes(dbHost);
console.log(`Database: ${dbHost}${isLocalDb ? " (local)" : ""}${dryRun ? " [dry run]" : ""}`);
if (!isLocalDb && !dryRun && !confirmed) {
  console.error("Not a local database. Re-run with --yes to write to it.");
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

function publicIdFor(photo: ManifestPhoto) {
  if (!photo.file && !photo.publicId) throw new Error(`Photo in ${photo.album} needs a file or a publicId`);
  return photo.publicId ?? `gallery/${photo.album}/${slugify(basename(photo.file!, extname(photo.file!)))}`;
}

/** Catch manifest mistakes before anything is uploaded or written. */
function validate() {
  const albumSlugs = new Set(manifest.albums.map((a) => a.slug));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const photo of manifest.photos) {
    if (!albumSlugs.has(photo.album)) problems.push(`unknown album "${photo.album}"`);
    const id = publicIdFor(photo);
    if (seen.has(id)) problems.push(`two photos would share the id ${id} (rename one file)`);
    seen.add(id);
    if (photo.file && !existsSync(photo.file)) problems.push(`missing file ${photo.file}`);
  }
  if (problems.length) {
    console.error(["Manifest problems:", ...problems].join("\n  "));
    process.exit(1);
  }
}

async function main() {
  validate();
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
  let moved = 0;
  let skipped = 0;
  for (const photo of manifest.photos) {
    const order = (orderInAlbum.get(photo.album) ?? 0) + 1;
    orderInAlbum.set(photo.album, order);
    const publicId = publicIdFor(photo);

    const existing = await prisma.galleryImage.findUnique({ where: { publicId } });
    if (dryRun) {
      console.log(`[dry-run] ${publicId} <- ${existing ? "(already a gallery photo)" : photo.file ?? "(already in Cloudinary)"}`);
      continue;
    }
    const albumId = albumIds.get(photo.album)!;
    if (existing) {
      // Already in the gallery: make sure it sits in this album, at this position.
      if (existing.albumId !== albumId || existing.order !== order) {
        await prisma.galleryImage.update({ where: { id: existing.id }, data: { albumId, order } });
        moved++;
      } else {
        skipped++;
      }
      continue;
    }

    const uploaded = photo.file
      ? await upload(photo.file, publicId)
      : { publicId, width: photo.width ?? null, height: photo.height ?? null };
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
  console.log(`Done: ${created} photos added, ${moved} moved into their album, ${skipped} already in place.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
