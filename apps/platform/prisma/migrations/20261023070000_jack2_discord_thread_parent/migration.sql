-- A Discord thread's channel (design §12.1, discord-read track): a thread syncs when its channel is opted
-- in, and its activity counts toward that channel. Nullable and unread by older code, so it's safe to
-- apply before the app deploys. DiscordChannel holds no personal data, so no RLS change is needed.

-- AlterTable
ALTER TABLE "public"."DiscordChannel" ADD COLUMN     "parentId" TEXT;
