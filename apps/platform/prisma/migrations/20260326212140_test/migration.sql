-- AlterTable
ALTER TABLE "public"."Entry" ADD COLUMN     "totalPositionsGained" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."RawResultUpload" ADD COLUMN     "sessionLabel" TEXT;

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "appleMapsUrl" TEXT,
ADD COLUMN     "googleMapsUrl" TEXT;
