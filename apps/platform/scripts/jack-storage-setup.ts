/**
 * Sets up Supabase Storage for Jack (#188, design §2.1 and §15): the private bucket `jack`, which holds
 * deck renders, exports and screenshots and the files officers attach in rooms.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts                   # create or update the bucket
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts --copy-from-blob  # also copy jack/assets/* from Vercel Blob
 *   ... --dry-run                                                                          # say what it would do, change nothing
 *
 * It uses NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, or from
 * .env.local / .env in the current folder (never overriding what's set), and prints which project it's
 * on before doing anything. Run it against production with production's values (a release step).
 *
 * The bucket: private (every read goes through an officer-only route or a short signed link), a 50 MB
 * per-file limit (the Supabase Free maximum; room uploads stop at 25 MB on their own), and an allow-list
 * of the types Jack stores. Running it again updates those settings.
 *
 * --copy-from-blob: copies the stored screenshots slides point at (`jack/assets/*`) from the private
 * Vercel Blob store to the bucket under the same names, skipping ones already there. Needs the Blob
 * credentials (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with a fresh VERCEL_OIDC_TOKEN from `vercel env
 * pull`). Renders and exports aren't copied: they're caches, made again on first view.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has("--dry-run")
const COPY = args.has("--copy-from-blob")
for (const arg of args) {
  if (!["--dry-run", "--copy-from-blob"].includes(arg)) {
    console.error(`Unknown option ${arg}. Options: --copy-from-blob, --dry-run`)
    process.exit(1)
  }
}

/** Supabase Free's largest file. Paid plans allow more, but nothing Jack stores needs it */
const FILE_SIZE_LIMIT = "50MB"
const ASSET_PREFIX = "jack/assets/"

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceKey) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (locally: `npx supabase status -o env`).")
    process.exit(1)
  }
  const { createClient } = await import("@supabase/supabase-js")
  const { JACK_BUCKET, supabaseStore } = await import("../src/server/jack/decks/storage")
  const { ROOM_FILE_CONTENT_TYPES } = await import("../src/lib/jack/files")
  const { EXPORT_TYPES } = await import("../src/server/jack/decks/exports")

  // Room files, plus what decks keep: renders (PNG, JPEG), their meta.json, exports (PDF, PPTX, ZIP) and the render check's text file
  const allowedMimeTypes = [...new Set([...ROOM_FILE_CONTENT_TYPES, "image/png", "image/jpeg", "application/json", "text/plain", ...Object.values(EXPORT_TYPES).map((t) => t.contentType)])].sort()
  const settings = { public: false, fileSizeLimit: FILE_SIZE_LIMIT, allowedMimeTypes }

  console.log(`Supabase project: ${new URL(url).host}${DRY_RUN ? " (dry run: nothing changes)" : ""}`)
  console.log(`Bucket "${JACK_BUCKET}": private, ${FILE_SIZE_LIMIT} per file, ${allowedMimeTypes.length} types allowed`)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const existing = await admin.storage.getBucket(JACK_BUCKET)
  if (existing.data) {
    if (existing.data.public) console.warn(`  The bucket is PUBLIC now; this makes it private.`)
    if (!DRY_RUN) {
      const { error } = await admin.storage.updateBucket(JACK_BUCKET, settings)
      if (error) throw new Error(`Couldn't update the bucket: ${error.message}`)
    }
    console.log(`  ${DRY_RUN ? "Would update" : "Updated"} the existing bucket.`)
  } else {
    if (!DRY_RUN) {
      const { error } = await admin.storage.createBucket(JACK_BUCKET, settings)
      if (error) throw new Error(`Couldn't create the bucket: ${error.message}`)
    }
    console.log(`  ${DRY_RUN ? "Would create" : "Created"} the bucket.`)
  }

  if (!COPY) return
  const blob = await import("@vercel/blob")
  const target = supabaseStore({ url, serviceKey })
  let cursor: string | undefined
  let copied = 0
  let skipped = 0
  console.log(`Copying ${ASSET_PREFIX}* from Vercel Blob:`)
  do {
    const page = await blob.list({ prefix: ASSET_PREFIX, cursor, limit: 1_000 })
    for (const item of page.blobs) {
      if (await target.head(item.pathname)) {
        skipped++
        continue
      }
      if (DRY_RUN) {
        copied++
        continue
      }
      const found = await blob.get(item.pathname, { access: "private" })
      if (!found || found.statusCode !== 200 || !found.stream) {
        console.warn(`  Couldn't read ${item.pathname} from Blob; skipped.`)
        continue
      }
      const body = Buffer.from(await new Response(found.stream).arrayBuffer())
      await target.put(item.pathname, body, found.blob.contentType || (item.pathname.endsWith(".png") ? "image/png" : "image/jpeg"))
      copied++
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  console.log(`  ${DRY_RUN ? "Would copy" : "Copied"} ${copied}, ${skipped} already there.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
