-- CreateEnum
CREATE TYPE "public"."SimExperience" AS ENUM ('NONE', 'CASUAL', 'SIM_RACER', 'COMPETITIVE');

-- CreateEnum
CREATE TYPE "public"."RacingEquipment" AS ENUM ('WHEEL', 'PEDALS', 'CONTROLLER', 'KEYBOARD');

-- CreateEnum
CREATE TYPE "public"."LeagueApplicationSource" AS ENUM ('SITE', 'ADMIN', 'GOOGLE_FORM');

-- CreateTable
CREATE TABLE "public"."LeagueApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "discordUsername" TEXT NOT NULL,
    "experience" "public"."SimExperience" NOT NULL,
    "equipment" "public"."RacingEquipment"[],
    "canCommit" BOOLEAN NOT NULL,
    "school" TEXT,
    "notes" TEXT,
    "source" "public"."LeagueApplicationSource" NOT NULL DEFAULT 'SITE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeagueApplication_seasonId_idx" ON "public"."LeagueApplication"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueApplication_userId_seasonId_key" ON "public"."LeagueApplication"("userId", "seasonId");

-- AddForeignKey
ALTER TABLE "public"."LeagueApplication" ADD CONSTRAINT "LeagueApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LeagueApplication" ADD CONSTRAINT "LeagueApplication_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
