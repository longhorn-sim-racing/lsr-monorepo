-- Drops models and columns nothing uses (#119).
-- Checked in production on 2026-10-08: EventEligibility, AuthIdentity and Media had 0 rows, and
-- Event.dialIn, Event.accessInstructions, Venue.geo, Entry.nickname and Entry.roundsCounted held no data.

-- DropForeignKey
ALTER TABLE "public"."AuthIdentity" DROP CONSTRAINT "AuthIdentity_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."EventEligibility" DROP CONSTRAINT "EventEligibility_eventId_fkey";

-- DropForeignKey
ALTER TABLE "public"."EventEligibility" DROP CONSTRAINT "EventEligibility_requiresLeagueId_fkey";

-- DropForeignKey
ALTER TABLE "public"."EventEligibility" DROP CONSTRAINT "EventEligibility_minRoleId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Media" DROP CONSTRAINT "Media_ownerId_fkey";

-- AlterTable
ALTER TABLE "public"."Entry" DROP COLUMN "nickname",
DROP COLUMN "roundsCounted";

-- AlterTable
ALTER TABLE "public"."Venue" DROP COLUMN "geo";

-- AlterTable
ALTER TABLE "public"."Event" DROP COLUMN "accessInstructions",
DROP COLUMN "dialIn";

-- DropTable
DROP TABLE "public"."AuthIdentity";

-- DropTable
DROP TABLE "public"."EventEligibility";

-- DropTable
DROP TABLE "public"."Media";

