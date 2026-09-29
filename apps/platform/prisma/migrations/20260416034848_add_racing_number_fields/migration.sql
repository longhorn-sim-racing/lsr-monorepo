/*
  Warnings:

  - A unique constraint covering the columns `[racingNumber]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "racingNumber" INTEGER,
ADD COLUMN     "racingNumberBorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "racingNumberColor" TEXT NOT NULL DEFAULT '#FFFFFF',
ADD COLUMN     "racingNumberFont" TEXT NOT NULL DEFAULT 'sans-serif',
ADD COLUMN     "racingNumberItalic" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "User_racingNumber_key" ON "public"."User"("racingNumber");
