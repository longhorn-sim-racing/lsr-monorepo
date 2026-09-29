-- Reconciles schema drift: these columns were added to schema.prisma without a migration.
-- Production already has these columns (verified 2026-04-15); on prod, run:
--   npx prisma migrate resolve --applied 20260415164226_reconcile_schema_drift

-- AlterTable
ALTER TABLE "Entry" ADD COLUMN "totalPositionsGained" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RawResultUpload" ADD COLUMN "sessionLabel" TEXT;

-- AlterTable
ALTER TABLE "Venue" ADD COLUMN "appleMapsUrl" TEXT,
ADD COLUMN "googleMapsUrl" TEXT;
