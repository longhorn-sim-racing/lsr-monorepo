import { formatDistanceToNow } from "date-fns";
import { requireOfficerPage } from "@/server/auth/guards";
import { getInstagramStatus } from "@/server/services/instagram.service";
import { getInstagramPostsForAdmin } from "@/server/queries/instagram";
import { cloudinaryUploadsConfigured } from "@/server/cloudinary";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { InstagramAdmin } from "./client";

export const dynamic = "force-dynamic";

function ago(iso?: string | null) {
  return iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : null;
}

function day(iso?: string | null) {
  return iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: DEFAULT_TIMEZONE })
    : null;
}

export default async function AdminInstagramPage() {
  await requireOfficerPage();
  const [status, posts] = await Promise.all([getInstagramStatus(), getInstagramPostsForAdmin()]);

  return (
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
  );
}
