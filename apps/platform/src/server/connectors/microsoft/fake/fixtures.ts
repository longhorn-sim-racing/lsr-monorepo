import ExcelJS from "exceljs"
import { strToU8 } from "fflate"
import { fakeDocx } from "../../google-drive/fake/fixtures"

/**
 * The Microsoft Graph fake's data (research/microsoft-graph.md §7): a SharePoint document library and
 * two Teams channels. All made up ("Fixture" names); it also fills the eval copy, and the repo is public.
 */

export const GRAPH_FAKE = {
  tenantId: "fixture-tenant",
  clientId: "fixture-client-id",
  clientSecret: "fixture-client-secret",
  siteId: "fixture.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
  driveId: "b!fixture-drive",
  teamId: "fbe2bf47-0000-4000-8000-000000000001",
  channels: { general: "19:fixture-general@thread.tacv2", sponsorship: "19:fixture-sponsorship@thread.tacv2" },
  clientState: "fixture-client-state-0123456789abcdef",
}

export type FakeGraphItem = {
  id: string
  name: string
  parentId: string | null
  folder?: boolean
  root?: boolean
  bytes?: () => Promise<Uint8Array>
  mimeType?: string
  deleted?: boolean
  version: number
  lastModified: string
}

export type FakeGraphMessage = {
  id: string
  channelId: string
  replyToId: string | null
  /** Who wrote it: a user, or an app (bot) when `app` is set */
  author: { id: string; name: string; app?: boolean } | null
  html: string
  messageType: "message" | "systemEventMessage"
  createdAt: string
  lastModifiedAt: string
  editedAt?: string
  deletedAt?: string
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

async function budgetWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet("Budget")
  for (const row of [
    ["Line", "Amount"],
    ["Showcase", 400],
    ["Tires for the rig", 120],
  ])
    sheet.addRow(row)
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

const at = (day: number, hour = 15) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()

/** The document library, root first */
export function sharePointFixtures(): FakeGraphItem[] {
  const item = (fields: Omit<FakeGraphItem, "version" | "lastModified"> & { day?: number }): FakeGraphItem => {
    const { day = 10, ...rest } = fields
    return { version: 1, lastModified: at(day), ...rest }
  }
  return [
    item({ id: "sp-root", name: "root", parentId: null, folder: true, root: true }),
    item({ id: "sp-general", name: "General", parentId: "sp-root", folder: true }),
    item({ id: "sp-budget", name: "Budget FA26.xlsx", parentId: "sp-general", mimeType: XLSX, bytes: budgetWorkbook }),
    item({ id: "sp-packet", name: "Sponsor Packet (fixture).docx", parentId: "sp-general", mimeType: DOCX, bytes: async () => fakeDocx(["Sponsor packet (fixture)", "Fixture Motors gets the Gold slot on the rig wrap."]) }),
    item({ id: "sp-transcripts", name: "Transcripts", parentId: "sp-root", folder: true }),
    item({
      id: "sp-transcript",
      name: "Officer meeting.vtt",
      parentId: "sp-transcripts",
      mimeType: "text/vtt",
      bytes: async () => strToU8("WEBVTT\n\n00:00:02.000 --> 00:00:05.000\n<v Fixture Officer A>Recruiting closes Friday.</v>\n\n00:00:06.000 --> 00:00:09.000\n<v Fixture Officer B>I'll post the reminder.</v>"),
    }),
    item({ id: "sp-rules", name: "Rules draft.md", parentId: "sp-root", mimeType: "text/markdown", bytes: async () => strToU8("# Rules draft (fixture)\n\n## Penalties\nA 5-second penalty for track limits.") }),
    item({ id: "sp-logo", name: "Logo.png", parentId: "sp-root", mimeType: "image/png", bytes: async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }),
  ]
}

/** Both channels' messages, oldest first */
export function teamsFixtures(): FakeGraphMessage[] {
  const { general, sponsorship } = GRAPH_FAKE.channels
  const message = (fields: Omit<FakeGraphMessage, "lastModifiedAt" | "messageType"> & { messageType?: FakeGraphMessage["messageType"] }): FakeGraphMessage => ({
    messageType: "message",
    lastModifiedAt: fields.createdAt,
    ...fields,
  })
  const a = { id: "aad-fixture-a", name: "Fixture Officer A" }
  const b = { id: "aad-fixture-b", name: "Fixture Officer B" }
  const c = { id: "aad-fixture-c", name: "Fixture Officer C" }
  return [
    message({ id: "1760454000000", channelId: general, replyToId: null, author: a, html: "<p>Who has the storage closet key this week?</p>", createdAt: at(14) }),
    message({ id: "1760454600000", channelId: general, replyToId: "1760454000000", author: b, html: '<p>I do. <at id="0">Fixture Officer A</at>, grab it from me before Friday.</p>', createdAt: at(14, 16) }),
    message({ id: "1760455000000", channelId: general, replyToId: null, author: null, html: "<systemEventMessage/>", messageType: "systemEventMessage", createdAt: at(14, 17) }),
    message({ id: "1760456000000", channelId: general, replyToId: null, author: a, html: "", createdAt: at(15), deletedAt: at(15, 18) }),
    message({
      id: "1760540000000",
      channelId: sponsorship,
      replyToId: null,
      author: c,
      html: "<div><p>Fixture Motors confirmed the sponsor call for <strong>Thursday at 4 PM</strong> in the engineering lounge.</p></div>",
      createdAt: at(15),
    }),
    message({ id: "1760540600000", channelId: sponsorship, replyToId: "1760540000000", author: a, html: 'Great, I&#39;ll bring the <a href="https://example.com/fixture-deck">pitch deck</a>.', createdAt: at(15, 16) }),
    message({ id: "1760541000000", channelId: sponsorship, replyToId: null, author: { id: "app-fixture", name: "Fixture Reminders", app: true }, html: "Weekly reminder: update the sponsor tracker.", createdAt: at(16) }),
  ]
}
