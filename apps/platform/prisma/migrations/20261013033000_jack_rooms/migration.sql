-- CreateEnum
CREATE TYPE "public"."JackPersona" AS ENUM ('jack', 'lift', 'stand');

-- CreateEnum
CREATE TYPE "public"."JackRoomPersona" AS ENUM ('jack', 'lift');

-- CreateEnum
CREATE TYPE "public"."JackMessageKind" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "public"."JackMessageStatus" AS ENUM ('streaming', 'done', 'error');

-- CreateTable
CREATE TABLE "public"."JackRoom" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "persona" "public"."JackRoomPersona" NOT NULL DEFAULT 'jack',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "runId" TEXT,
    "runStartedAt" TIMESTAMP(3),

    CONSTRAINT "JackRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JackMessage" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "kind" "public"."JackMessageKind" NOT NULL,
    "authorUserId" TEXT,
    "persona" "public"."JackPersona",
    "content" TEXT NOT NULL DEFAULT '',
    "toolCalls" JSONB,
    "status" "public"."JackMessageStatus" NOT NULL DEFAULT 'done',
    "streamSeq" INTEGER NOT NULL DEFAULT 0,
    "answeredById" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "costUsd" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JackRoom_archivedAt_updatedAt_idx" ON "public"."JackRoom"("archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "JackMessage_roomId_createdAt_idx" ON "public"."JackMessage"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "JackMessage_roomId_kind_answeredById_idx" ON "public"."JackMessage"("roomId", "kind", "answeredById");

-- CreateIndex
CREATE INDEX "JackMessage_authorUserId_idx" ON "public"."JackMessage"("authorUserId");

-- AddForeignKey
ALTER TABLE "public"."JackRoom" ADD CONSTRAINT "JackRoom_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackMessage" ADD CONSTRAINT "JackMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackMessage" ADD CONSTRAINT "JackMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackMessage" ADD CONSTRAINT "JackMessage_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "public"."JackMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Assistant messages, and only they, name their model; they have no officer author
ALTER TABLE "public"."JackMessage" ADD CONSTRAINT "JackMessage_persona_check" CHECK (("kind" = 'assistant') = ("persona" IS NOT NULL));
ALTER TABLE "public"."JackMessage" ADD CONSTRAINT "JackMessage_assistant_author_check" CHECK ("kind" <> 'assistant' OR "authorUserId" IS NULL);

-- ---------------------------------------------------------------------------
-- Realtime: only officers may use the private Broadcast channels `jack:room:<roomId>`.
--
-- The browser joins with the signed-in member's JWT and Realtime checks these RLS policies
-- on realtime.messages: SELECT to receive broadcasts and presence, INSERT to track presence.
-- Officers can't broadcast from the browser; every room event comes from the server with the
-- service role key, which bypasses RLS.
--
-- In production `anon` and `authenticated` have no usage on schema public, so the officer check
-- is a SECURITY DEFINER function in its own schema, callable only by `authenticated`. It takes no
-- arguments and reads the caller's id from the JWT itself (User.id is the Supabase auth user id),
-- so nobody can ask it about someone else.
--
-- Policies on realtime.messages are permissive and OR together: any policy added later must
-- leave `jack:%` topics out, or it opens these rooms to whoever it lets in.
--
-- Prisma's shadow database (and any Postgres that isn't Supabase) has no realtime or auth schema,
-- so this part only runs where they exist.
-- ---------------------------------------------------------------------------
DO $jack$
BEGIN
  IF to_regclass('realtime.messages') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE NOTICE 'No Supabase realtime/auth schema here; skipping the Jack channel policies';
    RETURN;
  END IF;

  EXECUTE 'CREATE SCHEMA IF NOT EXISTS jack_private';
  EXECUTE 'REVOKE ALL ON SCHEMA jack_private FROM PUBLIC, anon';

  EXECUTE $sql$
    CREATE OR REPLACE FUNCTION jack_private.is_officer()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $fn$
      SELECT EXISTS (
        SELECT 1
        FROM public."UserRole" ur
        JOIN public."Role" r ON r.id = ur."roleId"
        WHERE ur."userId" = (SELECT auth.uid())::text
          AND r.key IN ('officer', 'admin')
      )
    $fn$
  $sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION jack_private.is_officer() FROM PUBLIC, anon';
  EXECUTE 'GRANT USAGE ON SCHEMA jack_private TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION jack_private.is_officer() TO authenticated';

  EXECUTE 'DROP POLICY IF EXISTS "jack_officers_receive" ON realtime.messages';
  EXECUTE $sql$
    CREATE POLICY "jack_officers_receive" ON realtime.messages
    FOR SELECT TO authenticated
    USING (
      (SELECT realtime.topic()) LIKE 'jack:%'
      AND realtime.messages.extension IN ('broadcast', 'presence')
      AND (SELECT jack_private.is_officer())
    )
  $sql$;

  EXECUTE 'DROP POLICY IF EXISTS "jack_officers_track_presence" ON realtime.messages';
  EXECUTE $sql$
    CREATE POLICY "jack_officers_track_presence" ON realtime.messages
    FOR INSERT TO authenticated
    WITH CHECK (
      (SELECT realtime.topic()) LIKE 'jack:%'
      AND realtime.messages.extension = 'presence'
      AND (SELECT jack_private.is_officer())
    )
  $sql$;
END
$jack$;
