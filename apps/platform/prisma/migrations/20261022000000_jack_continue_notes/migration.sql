-- A room note can ask Jack to keep going on a deck that ran out of time or tool calls (#177).
-- Old code never sets it, and reads it as false, so this is safe to apply before the app deploys.

-- AlterTable
ALTER TABLE "public"."JackMessage" ADD COLUMN     "continues" BOOLEAN NOT NULL DEFAULT false;

