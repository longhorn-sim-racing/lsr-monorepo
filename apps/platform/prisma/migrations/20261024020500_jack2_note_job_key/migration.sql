-- Jack 2.0 T11 (automation): a note a scheduled job posts (a recurring question, the weekly digest)
-- records that job's key ("recurring:<id>", "digest.weekly"). A scheduled reply's history is then its own
-- job's notes only (the question and its last answer, design §11.1), and the Recurring questions and
-- Usage pages find each run's note and reply by it.
-- Additive: one nullable column and an index. Old code never sets it and never reads it, so this is safe
-- to apply before the app deploys. jack_readonly's table grant covers the new column.

-- AlterTable
ALTER TABLE "public"."JackMessage" ADD COLUMN     "jobKey" TEXT;

-- CreateIndex
CREATE INDEX "JackMessage_jobKey_createdAt_idx" ON "public"."JackMessage"("jobKey", "createdAt");
