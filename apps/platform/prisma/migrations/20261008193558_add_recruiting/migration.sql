-- CreateEnum
CREATE TYPE "public"."ApplicationState" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "public"."TrackStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'INTERVIEW', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "public"."RecruitingCycle" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "formVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitingCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Application" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "public"."ApplicationState" NOT NULL DEFAULT 'DRAFT',
    "fullName" TEXT,
    "email" TEXT,
    "eid" TEXT,
    "gradYear" INTEGER,
    "major" TEXT,
    "genericAnswers" JSONB NOT NULL DEFAULT '{}',
    "resumeUrl" TEXT,
    "portfolioLinks" JSONB NOT NULL DEFAULT '[]',
    "draftStep" TEXT,
    "formVersion" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ApplicationTrack" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" "public"."TrackStatus" NOT NULL DEFAULT 'SUBMITTED',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ApplicationReview" (
    "id" TEXT NOT NULL,
    "applicationTrackId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "score" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ApplicationEmail" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationTrackId" TEXT,
    "template" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "public"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "resendMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecruitingTrackConfig" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "schedulingUrl" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitingTrackConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecruitingEmailTemplate" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitingEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitingCycle_slug_key" ON "public"."RecruitingCycle"("slug");

-- CreateIndex
CREATE INDEX "Application_state_cycleId_updatedAt_idx" ON "public"."Application"("state", "cycleId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Application_cycleId_userId_key" ON "public"."Application"("cycleId", "userId");

-- CreateIndex
CREATE INDEX "ApplicationTrack_track_status_idx" ON "public"."ApplicationTrack"("track", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationTrack_applicationId_track_key" ON "public"."ApplicationTrack"("applicationId", "track");

-- CreateIndex
CREATE INDEX "ApplicationReview_applicationTrackId_idx" ON "public"."ApplicationReview"("applicationTrackId");

-- CreateIndex
CREATE INDEX "ApplicationEmail_status_createdAt_idx" ON "public"."ApplicationEmail"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationEmail_applicationId_idx" ON "public"."ApplicationEmail"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitingTrackConfig_cycleId_track_key" ON "public"."RecruitingTrackConfig"("cycleId", "track");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitingEmailTemplate_cycleId_track_template_key" ON "public"."RecruitingEmailTemplate"("cycleId", "track", "template");

-- AddForeignKey
ALTER TABLE "public"."Application" ADD CONSTRAINT "Application_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."RecruitingCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationTrack" ADD CONSTRAINT "ApplicationTrack_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationTrack" ADD CONSTRAINT "ApplicationTrack_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationReview" ADD CONSTRAINT "ApplicationReview_applicationTrackId_fkey" FOREIGN KEY ("applicationTrackId") REFERENCES "public"."ApplicationTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationReview" ADD CONSTRAINT "ApplicationReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationEmail" ADD CONSTRAINT "ApplicationEmail_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "public"."Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ApplicationEmail" ADD CONSTRAINT "ApplicationEmail_applicationTrackId_fkey" FOREIGN KEY ("applicationTrackId") REFERENCES "public"."ApplicationTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecruitingTrackConfig" ADD CONSTRAINT "RecruitingTrackConfig_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."RecruitingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecruitingEmailTemplate" ADD CONSTRAINT "RecruitingEmailTemplate_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "public"."RecruitingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Prisma can't express these) -----------------------------------------

-- At most one active recruiting round at a time.
CREATE UNIQUE INDEX "RecruitingCycle_single_active_idx" ON "public"."RecruitingCycle"("isActive") WHERE "isActive";

-- Row Level Security: Supabase exposes every table in `public` through its REST API to the
-- public anon key. These tables hold applicants' personal data and are only ever read through
-- Prisma (a direct connection as the table owner, which bypasses RLS), so turn RLS on with no
-- policies, and also revoke the API roles' table privileges.
ALTER TABLE "public"."RecruitingCycle"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Application"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ApplicationTrack"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ApplicationReview"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ApplicationEmail"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."RecruitingTrackConfig"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."RecruitingEmailTemplate" ENABLE ROW LEVEL SECURITY;

-- The anon / authenticated roles exist on Supabase but not on a plain Postgres (CI, other
-- tooling), so only revoke where they exist.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE "public"."RecruitingCycle", "public"."Application", "public"."ApplicationTrack", '
        '"public"."ApplicationReview", "public"."ApplicationEmail", "public"."RecruitingTrackConfig", '
        '"public"."RecruitingEmailTemplate" FROM %I', r);
    END IF;
  END LOOP;
END $$;
