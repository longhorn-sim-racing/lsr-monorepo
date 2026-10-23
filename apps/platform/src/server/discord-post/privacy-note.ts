import { privacyNoteText } from "@/lib/discord/privacy-note"
import { prisma } from "@/server/db"

/** The server privacy note for the channels that sync now (lib/discord/privacy-note.ts has the text), and their names */
export async function serverPrivacyNote(): Promise<{ text: string; channels: { id: string; name: string }[] }> {
  const synced = await prisma.discordChannel.findMany({ where: { synced: true, parentId: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })
  return { text: privacyNoteText(synced.map((c) => c.id)), channels: synced }
}
