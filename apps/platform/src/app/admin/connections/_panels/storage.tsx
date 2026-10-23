import { Badge, Button, DetailList, Notice, Panel, PanelBody, PanelHeader, ToneText, type Tone } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import type { JackFileStoreKind } from "@/server/jack/decks/storage"
import { formatStorageBytes, getStorageUsage, storageFill, SUPABASE_FREE_STORAGE_BYTES, type BucketUsage, type RoomFileCounts } from "@/server/jack/files/usage"

/**
 * Jack's file store on the Connections page (design §2.1, §13): which store is in use, how full the
 * Supabase bucket is against the Free plan's 1 GB, and the room files by status. Loads its own data;
 * the page renders it through SafeSlot, so a throw here shows a short notice instead.
 */

const STORE: Record<JackFileStoreKind, { label: string; tone: Tone }> = {
  supabase: { label: "Supabase Storage", tone: "success" },
  blob: { label: "Vercel Blob", tone: "warning" },
  files: { label: "Local folder", tone: "neutral" },
  none: { label: "None", tone: "danger" },
}

export async function StoragePanel() {
  const usage = await getStorageUsage()
  const store = STORE[usage.kind]
  return (
    <Panel>
      <PanelHeader
        title="File storage"
        description="Room files, deck renders and exports."
        actions={
          <>
            <Badge tone={store.tone}>{store.label}</Badge>
            {usage.kind !== "none" && (
              <Button size="sm" variant="ghost" asChild>
                <a href="/api/admin/jack/render-check" target="_blank" rel="noreferrer" title="Renders a test slide, then writes a small file to the store and reads it back (JSON)">
                  Render check
                </a>
              </Button>
            )}
          </>
        }
      />
      <PanelBody className="flex flex-col gap-3">
        <StoreNotice kind={usage.kind} bucket={usage.bucket} />
        <DetailList
          items={[
            ...(usage.kind === "supabase" ? bucketItems(usage.bucket, usage.bucketError) : []),
            ...(usage.kind === "files" ? [{ label: "Where", value: <span>.jack-renders/ on this machine</span> }] : []),
            { label: "Room files", value: <RoomFiles files={usage.files} /> },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

function StoreNotice({ kind, bucket }: { kind: JackFileStoreKind; bucket: BucketUsage | null }) {
  if (kind === "none") {
    return (
      <Notice tone="danger" title="No file store is connected">
        Renders aren&apos;t cached, and room uploads and deck screenshots don&apos;t work. Production uses Supabase Storage (SUPABASE_SERVICE_ROLE_KEY and the bucket from scripts/jack-storage-setup.ts).
      </Notice>
    )
  }
  if (kind === "blob") {
    return (
      <Notice tone="warning" title="Decks only">
        Vercel Blob can&apos;t take room uploads, and on Hobby it allows 2,000 writes a month. Supabase Storage is the default once SUPABASE_SERVICE_ROLE_KEY is set.
      </Notice>
    )
  }
  if (kind === "supabase" && bucket && !bucket.exists) {
    return (
      <Notice tone="danger" title={`The bucket “jack” doesn't exist yet`}>
        Every store call fails until it does: run scripts/jack-storage-setup.ts against this project (docs/jack-2/tracks/files.md).
      </Notice>
    )
  }
  return null
}

function bucketItems(bucket: BucketUsage | null, error?: string) {
  if (!bucket) return [{ label: "Usage", value: <span className="text-admin-subtle">{error ?? "Not available"}</span> }]
  const total = bucket.bytes + bucket.otherBytes
  const fill = storageFill(total)
  return [
    { label: "Used", value: <UsageBar bytes={total} share={fill.share} tone={fill.tone} /> },
    {
      label: "Bucket jack",
      value: (
        <span>
          {bucket.objects.toLocaleString("en-US")} {bucket.objects === 1 ? "file" : "files"}, {formatStorageBytes(bucket.bytes)}
          <span className="text-admin-subtle">
            {" "}
            · {bucket.public ? <ToneText tone="danger">public</ToneText> : "private"}
            {bucket.fileSizeLimit ? `, ${formatStorageBytes(bucket.fileSizeLimit)} per file` : ""}
          </span>
        </span>
      ),
    },
    ...(bucket.otherBytes > 0 ? [{ label: "Other buckets", value: <span>{formatStorageBytes(bucket.otherBytes)} (counts toward the same 1 GB)</span> }] : []),
  ]
}

const FILL: Record<"success" | "warning" | "danger", string> = {
  success: "bg-tone-success-foreground",
  warning: "bg-tone-warning-foreground",
  danger: "bg-tone-danger-foreground",
}

function UsageBar({ bytes, share, tone }: { bytes: number; share: number; tone: "success" | "warning" | "danger" }) {
  const percent = Math.round(share * 100)
  return (
    <span className="flex flex-col gap-1">
      <span>
        {formatStorageBytes(bytes)} of {formatStorageBytes(SUPABASE_FREE_STORAGE_BYTES)} (Free plan) ·{" "}
        <ToneText tone={tone === "success" ? "neutral" : tone}>{percent < 1 && bytes > 0 ? "under 1%" : `${percent}%`}</ToneText>
      </span>
      <span
        role="meter"
        aria-label="Storage used of the plan's 1 GB"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        className="block h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-muted"
      >
        <span className={cn("block h-full rounded-full", FILL[tone])} style={{ width: `${Math.min(100, Math.max(share > 0 ? 1 : 0, percent))}%` }} />
      </span>
    </span>
  )
}

function RoomFiles({ files }: { files: RoomFileCounts }) {
  if (files.ready + files.uploading + files.failed === 0) return <span className="text-admin-subtle">None yet</span>
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {files.ready.toLocaleString("en-US")} ready ({formatStorageBytes(files.readyBytes)})
        {files.uploading > 0 && <span className="text-admin-subtle"> · {files.uploading.toLocaleString("en-US")} uploading</span>}
        {files.failed > 0 && <ToneText tone="warning"> · {files.failed.toLocaleString("en-US")} failed</ToneText>}
      </span>
      {files.unposted > 0 && (
        <span className="text-xs text-admin-subtle">
          {files.unposted.toLocaleString("en-US")} never posted (the files.cleanup job deletes them after 7 days)
        </span>
      )}
    </span>
  )
}
