-- Retires the old results structure (#118) and adds the per-event waitlist toggle (#61).
-- Checked in production on 2026-10-08 before writing this: Round, Session, Result, Class, Team,
-- Track, Car, Provenance and ImportArtifact all had 0 rows; no Entry used teamId, classId or carId;
-- and there were no duplicate (seasonId, userId) entries, so the new unique index applies cleanly.

-- DropForeignKey
ALTER TABLE "public"."Round" DROP CONSTRAINT "Round_seasonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Round" DROP CONSTRAINT "Round_eventId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Session" DROP CONSTRAINT "Session_roundId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Session" DROP CONSTRAINT "Session_trackId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Session" DROP CONSTRAINT "Session_carId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Session" DROP CONSTRAINT "Session_classId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Class" DROP CONSTRAINT "Class_leagueId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Entry" DROP CONSTRAINT "Entry_teamId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Entry" DROP CONSTRAINT "Entry_classId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Entry" DROP CONSTRAINT "Entry_carId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Result" DROP CONSTRAINT "Result_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Result" DROP CONSTRAINT "Result_entryId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Result" DROP CONSTRAINT "Result_provenanceId_fkey";

-- DropForeignKey
ALTER TABLE "public"."Provenance" DROP CONSTRAINT "Provenance_createdById_fkey";

-- DropForeignKey
ALTER TABLE "public"."ImportArtifact" DROP CONSTRAINT "ImportArtifact_createdById_fkey";

-- DropForeignKey
ALTER TABLE "public"."ImportArtifact" DROP CONSTRAINT "ImportArtifact_provenanceId_fkey";

-- DropIndex
DROP INDEX "public"."Entry_seasonId_classId_idx";

-- DropIndex
DROP INDEX "public"."unique_entry_user";

-- AlterTable
ALTER TABLE "public"."Entry" DROP COLUMN "carId",
DROP COLUMN "classId",
DROP COLUMN "teamId";

-- AlterTable
ALTER TABLE "public"."Event" ADD COLUMN     "waitlistAutoPromote" BOOLEAN NOT NULL DEFAULT true;

-- DropTable
DROP TABLE "public"."Round";

-- DropTable
DROP TABLE "public"."Session";

-- DropTable
DROP TABLE "public"."Class";

-- DropTable
DROP TABLE "public"."Team";

-- DropTable
DROP TABLE "public"."Result";

-- DropTable
DROP TABLE "public"."Provenance";

-- DropTable
DROP TABLE "public"."ImportArtifact";

-- DropTable
DROP TABLE "public"."Track";

-- DropTable
DROP TABLE "public"."Car";

-- DropEnum
DROP TYPE "public"."SessionKind";

-- DropEnum
DROP TYPE "public"."FinishStatus";

-- DropEnum
DROP TYPE "public"."ResultSource";

-- CreateIndex
CREATE INDEX "Entry_seasonId_idx" ON "public"."Entry"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "unique_entry_user" ON "public"."Entry"("seasonId", "userId");

