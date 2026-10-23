-- A room note a scheduled run posts (a recurring question, design §11.1) is marked, so a room run that
-- picks it up answers it in a reply of its own, with no web tools (design §7.2).
-- Old code never sets it and never reads it, so this is safe to apply before the app deploys.

-- AlterTable
ALTER TABLE "public"."JackMessage" ADD COLUMN     "scheduled" BOOLEAN NOT NULL DEFAULT false;
