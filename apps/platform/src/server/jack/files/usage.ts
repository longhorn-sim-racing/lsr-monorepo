import { prisma } from "@/server/db"
import { JACK_BUCKET, jackFileStore, type JackFileStoreKind } from "@/server/jack/decks/storage"

/**
 * What Jack's file store holds, for the storage panel on the Connections page (design §13): which store
 * is in use (as /api/admin/jack/render-check reports it), and on Supabase Storage the `jack` bucket's
 * objects and bytes against the Free plan's 1 GB, plus room files by status. Storage's tables live in
 * the same Postgres as the app (`storage.objects`), so the numbers come from one query there; a database
 * without them (no storage schema, no grant, or a role that row-level security hides their rows from)
 * leaves the usage out instead of failing the page. Nothing here is a key or a link with one.
 */

/** Supabase Free includes 1 GB of storage across all buckets (supabase.com/pricing, checked 10/22). Decimal, like the plan's GB */
export const SUPABASE_FREE_STORAGE_BYTES = 1_000_000_000

/** The bucket as Storage's own tables have it. `otherBytes`: every other bucket, which counts toward the same 1 GB */
export type BucketUsage = { exists: boolean; public: boolean; fileSizeLimit: number | null; objects: number; bytes: number; otherBytes: number }

export type RoomFileCounts = { uploading: number; ready: number; failed: number; readyBytes: number; unposted: number }

export type StorageUsage = {
  kind: JackFileStoreKind
  /** Supabase only; null on other stores, and when Storage's tables couldn't be read */
  bucket: BucketUsage | null
  /** Supabase only: why the bucket's usage is missing */
  bucketError?: string
  files: RoomFileCounts
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const kind = jackFileStore().kind
  const [bucket, files] = await Promise.all([kind === "supabase" ? readBucketUsage() : Promise.resolve(null), roomFileCounts()])
  if (kind !== "supabase") return { kind, bucket: null, files }
  if (bucket === null) return { kind, bucket: null, bucketError: "Couldn't read Storage's tables (storage.objects) from the database: missing, not granted, or hidden by row-level security", files }
  return { kind, bucket, files }
}

/**
 * The bucket's settings and usage from storage.buckets and storage.objects, or null when they can't be
 * read. Both tables have row-level security on: a role it applies to (no BYPASSRLS, not their owner) reads
 * no rows and no error, which would look like a missing bucket, so that counts as unreadable too
 */
export async function readBucketUsage(bucket = JACK_BUCKET): Promise<BucketUsage | null> {
  try {
    const [present] = await prisma.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('storage.objects') IS NOT NULL AND to_regclass('storage.buckets') IS NOT NULL
        AND NOT coalesce(row_security_active(to_regclass('storage.objects')) OR row_security_active(to_regclass('storage.buckets')), true) AS present`
    if (!present?.present) return null
    const [settings, sizes] = await Promise.all([
      prisma.$queryRaw<{ public: boolean; fileSizeLimit: bigint | number | null }[]>`
        SELECT public, file_size_limit AS "fileSizeLimit" FROM storage.buckets WHERE id = ${bucket}`,
      // metadata.size is the object's byte count; anything else (a placeholder with no metadata) counts as 0
      prisma.$queryRaw<{ mine: boolean; objects: number; bytes: bigint | number }[]>`
        SELECT bucket_id = ${bucket} AS mine, count(*)::int AS objects,
          coalesce(sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint END), 0)::bigint AS bytes
        FROM storage.objects GROUP BY 1`,
    ])
    const mine = sizes.find((row) => row.mine)
    const others = sizes.filter((row) => !row.mine)
    return {
      exists: settings.length > 0,
      public: settings[0]?.public ?? false,
      fileSizeLimit: settings[0]?.fileSizeLimit == null ? null : Number(settings[0].fileSizeLimit),
      objects: mine?.objects ?? 0,
      bytes: Number(mine?.bytes ?? 0),
      otherBytes: others.reduce((sum, row) => sum + Number(row.bytes), 0),
    }
  } catch (error) {
    console.error("[jack] Couldn't read Storage usage:", error instanceof Error ? error.message : error)
    return null
  }
}

/** Room files by status (JackFile), with what READY ones hold, and how many were never posted (the cleanup job deletes those after 7 days) */
export async function roomFileCounts(): Promise<RoomFileCounts> {
  const [groups, unposted] = await Promise.all([
    prisma.jackFile.groupBy({ by: ["status"], _count: { _all: true }, _sum: { sizeBytes: true } }),
    prisma.jackFile.count({ where: { status: "READY", messageId: null } }),
  ])
  const of = (status: string) => groups.find((g) => g.status === status)
  return {
    uploading: of("UPLOADING")?._count._all ?? 0,
    ready: of("READY")?._count._all ?? 0,
    failed: of("FAILED")?._count._all ?? 0,
    readyBytes: of("READY")?._sum.sizeBytes ?? 0,
    unposted,
  }
}

/** "0 B", "840 KB", "12.5 MB", "1.02 GB" (decimal units, like the plan's limits) */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1_000) return `${Math.max(0, Math.round(bytes))} B`
  const [size, unit] = bytes < 1_000_000 ? [bytes / 1_000, "KB"] : bytes < 1_000_000_000 ? [bytes / 1_000_000, "MB"] : [bytes / 1_000_000_000, "GB"]
  const digits = unit === "GB" ? (size < 10 ? 2 : 1) : size < 100 ? 1 : 0
  return `${size.toFixed(digits).replace(/\.0+$/, "")} ${unit}`
}

/** How full the plan is: share of the limit (0 to 1, past 1 when over) and how loud to show it */
export function storageFill(bytes: number, limit = SUPABASE_FREE_STORAGE_BYTES): { share: number; tone: "success" | "warning" | "danger" } {
  const share = limit > 0 ? bytes / limit : 0
  return { share, tone: share >= 0.95 ? "danger" : share >= 0.8 ? "warning" : "success" }
}
