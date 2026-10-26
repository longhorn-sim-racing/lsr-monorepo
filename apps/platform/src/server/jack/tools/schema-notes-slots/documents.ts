import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the documents track's tables: synced documents and Teams messages */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Documents and Teams (synced copies; search and read are the better way in, and they skip sources that are switched off)
- "ExternalDocument" is one file from the club's Google Drive folder (source drive, externalId = Drive's file id) or SharePoint library (source sharepoint, externalId = "driveId!itemId"). path is its folder ("/Sponsors/2026"), webUrl opens it. text holds up to 200,000 characters; textStatus says why there's none or only part: ok, truncated, too_large, unsupported, restricted (downloads off), none (a scan), error. A Sheet's text is its first tab only. A removed file keeps its row with deletedAt set and text null: filter deletedAt IS NULL.
- "TeamsChannel" is a configured channel of the club's team (synced = still configured). "TeamsMessage" is one message as plain text: replyToId is its thread's first message; deleted ones have deletedAt set and content "". Times are UTC.
- "GraphSubscription" is a change-notification subscription on a channel's messages (renewed every couple of days); it holds no secret, only a hash.`,
  tableNotes: {
    ExternalDocument: "A synced Drive or SharePoint file: text (capped), textStatus, path, webUrl. Removed ones have deletedAt and no text.",
    TeamsChannel: "A configured Teams channel; synced = still configured.",
    TeamsMessage: "A Teams channel message as text; replyToId = its thread's first message. Deleted: deletedAt set, content empty.",
    GraphSubscription: "A Graph change-notification subscription on one channel's messages.",
  },
}
