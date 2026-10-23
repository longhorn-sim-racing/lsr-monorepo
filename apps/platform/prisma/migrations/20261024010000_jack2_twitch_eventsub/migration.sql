-- Jack 2.0 T5 (Twitch): EventSub message ids the webhook has handled (design §12.2). Twitch resends a
-- message with the same id when a delivery fails or times out, so /api/webhooks/twitch records each id
-- and skips one it has seen. The hourly Twitch token check prunes ids older than 2 days (the webhook
-- refuses messages older than 10 minutes anyway).
-- Additive: one new table, nothing else changes. Not personal data; jack_readonly's default grant covers it.

-- CreateTable
CREATE TABLE "public"."TwitchEventSubMessage" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwitchEventSubMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TwitchEventSubMessage_receivedAt_idx" ON "public"."TwitchEventSubMessage"("receivedAt");
