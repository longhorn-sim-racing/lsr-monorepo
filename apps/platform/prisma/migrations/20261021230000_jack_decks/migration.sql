-- Jack's slide decks and social graphics (#177).
--
-- Jack (the officer chat agent) reads these like every other table: jack_readonly gets SELECT on new
-- public tables through the default privileges set in 20261013180000_jack_sql_role, and these tables
-- don't turn on row level security, so no policy is needed. Nothing here is secret.

-- CreateEnum
CREATE TYPE "public"."JackDeckSize" AS ENUM ('slides', 'post', 'story', 'square');

-- CreateTable
CREATE TABLE "public"."JackDeck" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "size" "public"."JackDeckSize" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "roomId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JackDeck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JackDeckVersion" (
    "id" TEXT NOT NULL,
    "deckId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "messageId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JackDeckVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JackDeck_updatedAt_idx" ON "public"."JackDeck"("updatedAt");

-- CreateIndex
CREATE INDEX "JackDeck_roomId_idx" ON "public"."JackDeck"("roomId");

-- CreateIndex
CREATE INDEX "JackDeckVersion_messageId_idx" ON "public"."JackDeckVersion"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "JackDeckVersion_deckId_version_key" ON "public"."JackDeckVersion"("deckId", "version");

-- AddForeignKey
ALTER TABLE "public"."JackDeck" ADD CONSTRAINT "JackDeck_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackDeck" ADD CONSTRAINT "JackDeck_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackDeckVersion" ADD CONSTRAINT "JackDeckVersion_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "public"."JackDeck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackDeckVersion" ADD CONSTRAINT "JackDeckVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."JackMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackDeckVersion" ADD CONSTRAINT "JackDeckVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

