-- Jack (#161): what Stand's side jobs cost, one row per Claude call whatever came of it, so the
-- spend meter counts calls that didn't end in a "Stand named this room" note too. Replies keep their
-- cost on their own JackMessage row.
--
-- jack_readonly can read this table (the default privileges from the jack_sql_role migration grant
-- SELECT on new public tables); it holds token counts and costs, nothing secret.

-- CreateTable
CREATE TABLE "public"."JackUsage" (
    "id" TEXT NOT NULL,
    "roomId" TEXT,
    "persona" "public"."JackPersona" NOT NULL,
    "job" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JackUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JackUsage_createdAt_idx" ON "public"."JackUsage"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."JackUsage" ADD CONSTRAINT "JackUsage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
