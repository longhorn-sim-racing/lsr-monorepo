-- ---------------------------------------------------------------------------
-- Jack 2.0 core schema (#188; design: docs/jack-2/design.md §3).
--
-- Additive only: new enums and tables, new nullable or defaulted columns, new indexes. Code that's
-- already running never reads any of it, so this is safe to apply before the app deploys (and the
-- 2.0 release applies its migrations to production first, because getSessionUser reads whole User
-- rows; see the design's release plan). No existing table gains a tsvector column, so run_sql's
-- SELECT * keeps working for Jack 1.x too.
--
-- The generated part is Prisma's. The hand-written tail (after it) adds what Prisma can't express:
--   1. full-text search: triggers keep "JackSearchDoc" (one row per room message, knowledge entry,
--      document and Teams message) current, and existing room messages are indexed,
--   2. deleting a recurring question deletes its scheduled job,
--   3. row level security on the tables that hold personal data, with a read policy for
--      jack_readonly only (the same pattern as 20261015000000_add_recruiting); "JackSearchDoc" gets
--      none,
--   4. a row per outside connector in ConnectorState, all switched off.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "public"."JackProposalStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'DISCARDED', 'FAILED', 'STALE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "public"."JackFileKind" AS ENUM ('IMAGE', 'PDF', 'SPREADSHEET', 'CSV', 'JSON', 'TEXT', 'DOCUMENT', 'TRANSCRIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."JackFileStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."KnowledgeSource" AS ENUM ('MANUAL', 'JACK', 'SEED');

-- CreateEnum
CREATE TYPE "public"."DiscordPostStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "public"."InstagramPost" ADD COLUMN     "comments" INTEGER,
ADD COLUMN     "insightsAt" TIMESTAMP(3),
ADD COLUMN     "likes" INTEGER,
ADD COLUMN     "reach" INTEGER,
ADD COLUMN     "saved" INTEGER,
ADD COLUMN     "shares" INTEGER,
ADD COLUMN     "views" INTEGER;

-- AlterTable
ALTER TABLE "public"."JackMessage" ADD COLUMN     "authorLabel" TEXT,
ADD COLUMN     "expectsAnswer" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "public"."JackRoom" ADD COLUMN     "answerMode" TEXT NOT NULL DEFAULT 'always',
ADD COLUMN     "pinnedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "department" TEXT,
ADD COLUMN     "discordLinkedAt" TIMESTAMP(3),
ADD COLUMN     "discordUserId" TEXT,
ADD COLUMN     "discordUsername" TEXT,
ADD COLUMN     "isBoard" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workingOn" VARCHAR(160);

-- CreateTable
CREATE TABLE "public"."JackProposal" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "before" JSONB,
    "targetType" TEXT,
    "targetId" TEXT,
    "status" "public"."JackProposalStatus" NOT NULL DEFAULT 'PENDING',
    "claimedAt" TIMESTAMP(3),
    "proposedForId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "supersededById" TEXT,
    "fileSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JackProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JackFile" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "messageId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT,
    "kind" "public"."JackFileKind" NOT NULL,
    "status" "public"."JackFileStatus" NOT NULL DEFAULT 'UPLOADING',
    "modelCopyPath" TEXT,
    "anthropicFileId" TEXT,
    "thumbPath" TEXT,
    "pageCount" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "text" TEXT,
    "textStatus" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JackFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceType" "public"."KnowledgeSource" NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "sourceNote" TEXT,
    "sourceDate" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "provenance" JSONB,
    "ownerId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KnowledgeEntryVersion" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "editedById" TEXT,
    "via" TEXT NOT NULL,
    "roomId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeEntryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScheduledJob" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScheduledJobRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "error" TEXT,

    CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SchedulerHeartbeat" (
    "id" TEXT NOT NULL DEFAULT 'tick',
    "lastTickAt" TIMESTAMP(3) NOT NULL,
    "lastDispatchAt" TIMESTAMP(3),

    CONSTRAINT "SchedulerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConnectorState" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "cursor" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExternalDocument" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "driveId" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "webUrl" TEXT NOT NULL,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "sizeBytes" BIGINT,
    "version" TEXT,
    "text" TEXT,
    "textStatus" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TeamsChannel" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "deltaLink" TEXT,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "TeamsChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TeamsMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "replyToId" TEXT,
    "authorAadId" TEXT,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TeamsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GraphSubscription" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "clientStateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    "parentName" TEXT,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "rescanFrom" TIMESTAMP(3),

    CONSTRAINT "DiscordChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "contentLength" INTEGER NOT NULL DEFAULT 0,
    "attachments" INTEGER NOT NULL DEFAULT 0,
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "poll" JSONB,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordMember" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "joinedAt" TIMESTAMP(3),
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "DiscordMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordDailyStat" (
    "date" DATE NOT NULL,
    "channelId" TEXT NOT NULL,
    "messages" INTEGER NOT NULL,
    "activeAuthors" INTEGER NOT NULL,

    CONSTRAINT "DiscordDailyStat_pkey" PRIMARY KEY ("date","channelId")
);

-- CreateTable
CREATE TABLE "public"."DiscordGuildDaily" (
    "date" DATE NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "joinedCount" INTEGER,
    "leftCount" INTEGER,

    CONSTRAINT "DiscordGuildDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."DiscordRule" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channelId" TEXT,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordPost" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ruleId" TEXT,
    "proposalId" TEXT,
    "channelId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "nonce" VARCHAR(25),
    "status" "public"."DiscordPostStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "discordMessageId" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscordEventMirror" (
    "eventId" TEXT NOT NULL,
    "discordEventId" TEXT NOT NULL,
    "eventStartsAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "interestedCount" INTEGER,

    CONSTRAINT "DiscordEventMirror_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "public"."DiscordRoleRule" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,

    CONSTRAINT "DiscordRoleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TwitchStream" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "gameName" TEXT,
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "avgViewers" DOUBLE PRECISION,
    "vodId" TEXT,
    "vodViews" INTEGER,
    "vodViewsAt" TIMESTAMP(3),

    CONSTRAINT "TwitchStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TwitchViewerSample" (
    "streamId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "viewers" INTEGER NOT NULL,

    CONSTRAINT "TwitchViewerSample_pkey" PRIMARY KEY ("streamId","at")
);

-- CreateTable
CREATE TABLE "public"."TwitchChannelDaily" (
    "date" DATE NOT NULL,
    "followers" INTEGER,

    CONSTRAINT "TwitchChannelDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."StripeBalanceDaily" (
    "date" DATE NOT NULL,
    "availableCents" INTEGER NOT NULL,
    "pendingCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "StripeBalanceDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."StripePayout" (
    "id" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "arrivalDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT,
    "failureCode" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripePayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StripeDispute" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceDueBy" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StripeRefund" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EmailEvent" (
    "id" TEXT NOT NULL,
    "resendId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "detail" JSONB,
    "svixId" TEXT NOT NULL,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SiteTrafficDaily" (
    "date" DATE NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "pageviews" INTEGER NOT NULL,
    "visitors" INTEGER NOT NULL,

    CONSTRAINT "SiteTrafficDaily_pkey" PRIMARY KEY ("date","dimension","key")
);

-- CreateTable
CREATE TABLE "public"."InstagramAccountDaily" (
    "date" DATE NOT NULL,
    "followers" INTEGER NOT NULL,
    "reach" INTEGER,
    "views" INTEGER,
    "accountsEngaged" INTEGER,
    "totalInteractions" INTEGER,
    "follows" INTEGER,
    "unfollows" INTEGER,

    CONSTRAINT "InstagramAccountDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."InstagramPublish" (
    "id" TEXT NOT NULL,
    "deckId" TEXT,
    "version" INTEGER,
    "slideIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaType" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "containerIds" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "claimedAt" TIMESTAMP(3),
    "igMediaId" TEXT,
    "permalink" TEXT,
    "error" TEXT,
    "proposalId" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramPublish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SponsorProspect" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "website" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactRole" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'idea',
    "tierInterest" TEXT,
    "ownerId" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "nextStep" TEXT,
    "nextStepDue" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SponsorActivity" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "byId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Meeting" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL,
    "agendaMd" TEXT,
    "summaryMd" TEXT,
    "transcriptFileId" TEXT,
    "transcriptDocumentId" TEXT,
    "roomId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MeetingDecision" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT,
    "text" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "knowledgeEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ActionItem" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "doneAt" TIMESTAMP(3),
    "meetingId" TEXT,
    "roomId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecurringQuestion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "persona" TEXT NOT NULL DEFAULT 'jack',
    "scheduledJobId" TEXT NOT NULL,
    "createdById" TEXT,
    "pausedReason" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JackFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JackFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JackSearchDoc" (
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "search" tsvector,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JackSearchDoc_pkey" PRIMARY KEY ("source","sourceId")
);

-- CreateIndex
CREATE INDEX "JackProposal_roomId_createdAt_idx" ON "public"."JackProposal"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "JackProposal_status_createdAt_idx" ON "public"."JackProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "JackProposal_targetType_targetId_idx" ON "public"."JackProposal"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "JackProposal_kind_targetType_targetId_status_idx" ON "public"."JackProposal"("kind", "targetType", "targetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JackFile_storagePath_key" ON "public"."JackFile"("storagePath");

-- CreateIndex
CREATE INDEX "JackFile_roomId_createdAt_idx" ON "public"."JackFile"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "JackFile_messageId_idx" ON "public"."JackFile"("messageId");

-- CreateIndex
CREATE INDEX "JackFile_status_createdAt_idx" ON "public"."JackFile"("status", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_archivedAt_updatedAt_idx" ON "public"."KnowledgeEntry"("archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_ownerId_idx" ON "public"."KnowledgeEntry"("ownerId");

-- CreateIndex
CREATE INDEX "KnowledgeEntryVersion_entryId_createdAt_idx" ON "public"."KnowledgeEntryVersion"("entryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_key_key" ON "public"."ScheduledJob"("key");

-- CreateIndex
CREATE INDEX "ScheduledJob_enabled_nextRunAt_idx" ON "public"."ScheduledJob"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_jobId_startedAt_idx" ON "public"."ScheduledJobRun"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_startedAt_idx" ON "public"."ScheduledJobRun"("startedAt");

-- CreateIndex
CREATE INDEX "ExternalDocument_source_modifiedAt_idx" ON "public"."ExternalDocument"("source", "modifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalDocument_source_externalId_key" ON "public"."ExternalDocument"("source", "externalId");

-- CreateIndex
CREATE INDEX "TeamsMessage_channelId_createdAt_idx" ON "public"."TeamsMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscordMessage_channelId_createdAt_idx" ON "public"."DiscordMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscordMessage_authorId_createdAt_idx" ON "public"."DiscordMessage"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscordMember_userId_idx" ON "public"."DiscordMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordPost_dedupeKey_key" ON "public"."DiscordPost"("dedupeKey");

-- CreateIndex
CREATE INDEX "DiscordPost_status_scheduledFor_idx" ON "public"."DiscordPost"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordEventMirror_discordEventId_key" ON "public"."DiscordEventMirror"("discordEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_svixId_key" ON "public"."EmailEvent"("svixId");

-- CreateIndex
CREATE INDEX "EmailEvent_resendId_occurredAt_idx" ON "public"."EmailEvent"("resendId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_recipient_occurredAt_idx" ON "public"."EmailEvent"("recipient", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_type_occurredAt_idx" ON "public"."EmailEvent"("type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramPublish_proposalId_key" ON "public"."InstagramPublish"("proposalId");

-- CreateIndex
CREATE INDEX "SponsorProspect_stage_updatedAt_idx" ON "public"."SponsorProspect"("stage", "updatedAt");

-- CreateIndex
CREATE INDEX "SponsorProspect_ownerId_idx" ON "public"."SponsorProspect"("ownerId");

-- CreateIndex
CREATE INDEX "SponsorActivity_prospectId_occurredAt_idx" ON "public"."SponsorActivity"("prospectId", "occurredAt");

-- CreateIndex
CREATE INDEX "Meeting_heldAt_idx" ON "public"."Meeting"("heldAt");

-- CreateIndex
CREATE INDEX "Meeting_roomId_idx" ON "public"."Meeting"("roomId");

-- CreateIndex
CREATE INDEX "Meeting_transcriptFileId_idx" ON "public"."Meeting"("transcriptFileId");

-- CreateIndex
CREATE INDEX "Meeting_transcriptDocumentId_idx" ON "public"."Meeting"("transcriptDocumentId");

-- CreateIndex
CREATE INDEX "MeetingDecision_meetingId_idx" ON "public"."MeetingDecision"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingDecision_knowledgeEntryId_idx" ON "public"."MeetingDecision"("knowledgeEntryId");

-- CreateIndex
CREATE INDEX "ActionItem_status_dueAt_idx" ON "public"."ActionItem"("status", "dueAt");

-- CreateIndex
CREATE INDEX "ActionItem_ownerId_status_idx" ON "public"."ActionItem"("ownerId", "status");

-- CreateIndex
CREATE INDEX "ActionItem_meetingId_idx" ON "public"."ActionItem"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringQuestion_scheduledJobId_key" ON "public"."RecurringQuestion"("scheduledJobId");

-- CreateIndex
CREATE INDEX "RecurringQuestion_roomId_idx" ON "public"."RecurringQuestion"("roomId");

-- CreateIndex
CREATE INDEX "RecurringQuestion_createdById_idx" ON "public"."RecurringQuestion"("createdById");

-- CreateIndex
CREATE INDEX "JackFeedback_userId_idx" ON "public"."JackFeedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "JackFeedback_messageId_userId_key" ON "public"."JackFeedback"("messageId", "userId");

-- CreateIndex
CREATE INDEX "JackSearchDoc_search_idx" ON "public"."JackSearchDoc" USING GIN ("search");

-- CreateIndex
CREATE INDEX "ApplicationEmail_resendMessageId_idx" ON "public"."ApplicationEmail"("resendMessageId");

-- CreateIndex
CREATE INDEX "Notification_emailMessageId_idx" ON "public"."Notification"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "User_discordUserId_key" ON "public"."User"("discordUserId");

-- AddForeignKey
ALTER TABLE "public"."JackProposal" ADD CONSTRAINT "JackProposal_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackFile" ADD CONSTRAINT "JackFile_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackFile" ADD CONSTRAINT "JackFile_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."JackMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KnowledgeEntryVersion" ADD CONSTRAINT "KnowledgeEntryVersion_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."KnowledgeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduledJobRun" ADD CONSTRAINT "ScheduledJobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."ScheduledJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscordMember" ADD CONSTRAINT "DiscordMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TwitchViewerSample" ADD CONSTRAINT "TwitchViewerSample_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "public"."TwitchStream"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SponsorProspect" ADD CONSTRAINT "SponsorProspect_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SponsorActivity" ADD CONSTRAINT "SponsorActivity_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "public"."SponsorProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Meeting" ADD CONSTRAINT "Meeting_transcriptFileId_fkey" FOREIGN KEY ("transcriptFileId") REFERENCES "public"."JackFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Meeting" ADD CONSTRAINT "Meeting_transcriptDocumentId_fkey" FOREIGN KEY ("transcriptDocumentId") REFERENCES "public"."ExternalDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Meeting" ADD CONSTRAINT "Meeting_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MeetingDecision" ADD CONSTRAINT "MeetingDecision_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "public"."Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MeetingDecision" ADD CONSTRAINT "MeetingDecision_knowledgeEntryId_fkey" FOREIGN KEY ("knowledgeEntryId") REFERENCES "public"."KnowledgeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActionItem" ADD CONSTRAINT "ActionItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActionItem" ADD CONSTRAINT "ActionItem_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "public"."Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecurringQuestion" ADD CONSTRAINT "RecurringQuestion_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."JackRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecurringQuestion" ADD CONSTRAINT "RecurringQuestion_scheduledJobId_fkey" FOREIGN KEY ("scheduledJobId") REFERENCES "public"."ScheduledJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecurringQuestion" ADD CONSTRAINT "RecurringQuestion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackFeedback" ADD CONSTRAINT "JackFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."JackMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JackFeedback" ADD CONSTRAINT "JackFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written (Prisma can't express these)
-- ---------------------------------------------------------------------------

-- 1. Full-text search. One index table, "JackSearchDoc", kept current by triggers on the searchable
-- tables. It's separate so no table Jack reads with SELECT * carries a tsvector (Prisma can't
-- deserialize them, which would break run_sql's SELECT * queries, Jack 1.x's included). Inputs are
-- capped (a tsvector over 1 MB is an error). JackMessage is rewritten about once a second while a
-- reply streams, so a message is indexed only once it isn't streaming, and only when its text or
-- status changed.

CREATE OR REPLACE FUNCTION public.jack2_search_put(p_source text, p_id text, p_vector tsvector) RETURNS void
LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO public."JackSearchDoc" (source, "sourceId", search, "updatedAt")
  VALUES (p_source, p_id, p_vector, now() AT TIME ZONE 'UTC')
  ON CONFLICT (source, "sourceId") DO UPDATE SET search = EXCLUDED.search, "updatedAt" = EXCLUDED."updatedAt";
$$;

CREATE OR REPLACE FUNCTION public.jack2_search_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM public."JackSearchDoc" WHERE source = TG_ARGV[0] AND "sourceId" = OLD.id;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.jack2_message_search() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'streaming' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  PERFORM public.jack2_search_put('room_message', NEW.id,
    pg_catalog.to_tsvector('english'::regconfig, left(coalesce(NEW.content, ''), 100000)));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.jack2_knowledge_search() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.jack2_search_put('knowledge', NEW.id,
    setweight(pg_catalog.to_tsvector('english'::regconfig, coalesce(NEW.title, '')), 'A') ||
    setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(pg_catalog.array_to_string(NEW.tags, ' '), ''), 2000)), 'B') ||
    setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(NEW.body, ''), 100000)), 'C'));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.jack2_document_search() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.jack2_search_put('document', NEW.id,
    setweight(pg_catalog.to_tsvector('english'::regconfig, coalesce(NEW.name, '')), 'A') ||
    setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(NEW.path, ''), 1000)), 'B') ||
    setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(NEW.text, ''), 100000)), 'C'));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.jack2_teams_search() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.jack2_search_put('teams', NEW.id,
    setweight(pg_catalog.to_tsvector('simple'::regconfig, coalesce(NEW."authorName", '')), 'B') ||
    setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(NEW.content, ''), 100000)), 'C'));
  RETURN NULL;
END $$;

CREATE TRIGGER "JackMessage_search" AFTER INSERT OR UPDATE OF content, status ON public."JackMessage"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_message_search();
CREATE TRIGGER "JackMessage_search_delete" AFTER DELETE ON public."JackMessage"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_search_delete('room_message');
CREATE TRIGGER "KnowledgeEntry_search" AFTER INSERT OR UPDATE OF title, tags, body ON public."KnowledgeEntry"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_knowledge_search();
CREATE TRIGGER "KnowledgeEntry_search_delete" AFTER DELETE ON public."KnowledgeEntry"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_search_delete('knowledge');
CREATE TRIGGER "ExternalDocument_search" AFTER INSERT OR UPDATE OF name, path, text ON public."ExternalDocument"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_document_search();
CREATE TRIGGER "ExternalDocument_search_delete" AFTER DELETE ON public."ExternalDocument"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_search_delete('document');
CREATE TRIGGER "TeamsMessage_search" AFTER INSERT OR UPDATE OF "authorName", content ON public."TeamsMessage"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_teams_search();
CREATE TRIGGER "TeamsMessage_search_delete" AFTER DELETE ON public."TeamsMessage"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_search_delete('teams');

-- Index the room messages that already exist (the other tables are new and empty)
INSERT INTO public."JackSearchDoc" (source, "sourceId", search, "updatedAt")
SELECT 'room_message', id, pg_catalog.to_tsvector('english'::regconfig, left(coalesce(content, ''), 100000)), now() AT TIME ZONE 'UTC'
FROM public."JackMessage"
WHERE status <> 'streaming'
ON CONFLICT (source, "sourceId") DO NOTHING;

-- 2. A recurring question owns its scheduled job: deleting the question (or the room it lives in)
-- deletes the job, so it can't keep coming due
CREATE OR REPLACE FUNCTION public.jack2_recurring_job_cleanup() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM public."ScheduledJob" WHERE id = OLD."scheduledJobId";
  RETURN NULL;
END $$;

CREATE TRIGGER "RecurringQuestion_job_cleanup" AFTER DELETE ON public."RecurringQuestion"
  FOR EACH ROW EXECUTE FUNCTION public.jack2_recurring_job_cleanup();

-- These functions only run inside the triggers above
REVOKE EXECUTE ON FUNCTION public.jack2_search_put(text, text, tsvector), public.jack2_search_delete(),
  public.jack2_message_search(), public.jack2_knowledge_search(), public.jack2_document_search(),
  public.jack2_teams_search(), public.jack2_recurring_job_cleanup() FROM PUBLIC;

-- 3. Row level security on tables that hold personal data. The app connects as the table owner, so
-- RLS doesn't change what it can do; it keeps the anon and authenticated roles out (in production
-- they have no access to schema public anyway, but locally they do), and jack_readonly reads through
-- an explicit policy. Same pattern as the recruiting tables. "JackSearchDoc" (lexemes of everything
-- searchable) gets RLS with NO policy for jack_readonly: search goes through the tools.
ALTER TABLE public."JackFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."JackProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EmailEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ExternalDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DiscordMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DiscordMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TeamsMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SponsorProspect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SponsorActivity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Meeting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MeetingDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ActionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."KnowledgeEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."KnowledgeEntryVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."JackSearchDoc" ENABLE ROW LEVEL SECURITY;

DO $rls$
DECLARE
  t text;
  r text;
  personal text[] := ARRAY[
    'JackFile', 'JackProposal', 'EmailEvent', 'ExternalDocument', 'DiscordMessage', 'DiscordMember',
    'TeamsMessage', 'SponsorProspect', 'SponsorActivity', 'Meeting', 'MeetingDecision', 'ActionItem',
    'KnowledgeEntry', 'KnowledgeEntryVersion'
  ];
BEGIN
  -- Supabase's API roles get nothing on these tables (they don't exist on plain Postgres)
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY personal || ARRAY['JackSearchDoc'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;

  -- jack_readonly reads the personal-data tables through a policy (without one it would see zero
  -- rows); "JackSearchDoc" deliberately has none
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    FOREACH t IN ARRAY personal LOOP
      EXECUTE format('DROP POLICY IF EXISTS jack_readonly_select ON public.%I', t);
      EXECUTE format('CREATE POLICY jack_readonly_select ON public.%I FOR SELECT TO jack_readonly USING (true)', t);
    END LOOP;
  END IF;

  -- Checks: every personal-data table has RLS on, and Jack's role can still only read
  FOREACH t IN ARRAY personal || ARRAY['JackSearchDoc'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      RAISE EXCEPTION 'row level security is off on %', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') AND EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege('jack_readonly', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'jack_readonly holds a table privilege other than SELECT in schema public';
  END IF;
END
$rls$;

-- 4. One row per outside connector, all off: admins switch each on after its smoke test (design §12)
INSERT INTO public."ConnectorState" (id, enabled, "updatedAt")
VALUES
  ('discord', false, now() AT TIME ZONE 'UTC'),
  ('twitch', false, now() AT TIME ZONE 'UTC'),
  ('stripe', false, now() AT TIME ZONE 'UTC'),
  ('resend', false, now() AT TIME ZONE 'UTC'),
  ('site-traffic', false, now() AT TIME ZONE 'UTC'),
  ('instagram-insights', false, now() AT TIME ZONE 'UTC'),
  ('instagram-publish', false, now() AT TIME ZONE 'UTC'),
  ('google-drive', false, now() AT TIME ZONE 'UTC'),
  ('sharepoint', false, now() AT TIME ZONE 'UTC'),
  ('teams', false, now() AT TIME ZONE 'UTC')
ON CONFLICT (id) DO NOTHING;
