import type { Metadata } from "next"
import { formatDistanceToNow } from "date-fns"
import { requireOfficerPage } from "@/server/auth/guards"
import { getInstagramStatus } from "@/server/services/instagram.service"
import { getInstagramPostsForAdmin } from "@/server/queries/instagram"
import { cloudinaryUploadsConfigured } from "@/server/cloudinary"
import { PageHeader } from "@/components/admin/kit"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { InstagramSections } from "./_sections"
import { InstagramAdmin } from "./client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Instagram" }

function ago(iso?: string | null) {
  return iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : null
}

function day(iso?: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: DEFAULT_TIMEZONE }) : null
}

export default async function AdminInstagramPage() {
  await requireOfficerPage()
  const [status, posts] = await Promise.all([getInstagramStatus(), getInstagramPostsForAdmin()])

  return (
    <>
      <PageHeader title="Instagram" description="New posts from the club account show up on the News page within the hour." />
      <InstagramAdmin
        status={{
          connected: status.connected,
          username: status.username ?? null,
          lastSync: ago(status.lastSyncAt),
          tokenExpires: day(status.tokenExpiresAt),
          lastError: status.lastError ?? null,
          lastErrorAt: ago(status.lastErrorAt),
        }}
        imagesReady={cloudinaryUploadsConfigured()}
        posts={posts.map((post) => ({
          id: post.id,
          permalink: post.permalink,
          caption: post.caption,
          mediaType: post.mediaType,
          publicId: post.publicId,
          hidden: post.hidden,
          postedAt: day(post.postedAt.toISOString())!,
        }))}
      />
      {/* Sections the Jack 2.0 tracks add (insights, publish history); nothing while there are none */}
      <InstagramSections />
    </>
  )
}
