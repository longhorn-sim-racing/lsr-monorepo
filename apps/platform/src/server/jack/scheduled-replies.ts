import { isRecurringPersona, recurringIdFromJobKey } from "@/lib/jack/recurring"
import type { JackRoomPersonaKey } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { jackMessageInclude, type JackMessageRow } from "./messages"

/**
 * Replies to scheduled notes (design §11): a recurring question's, or the weekly digest's request for a
 * summary. The reply loop answers each in a reply of its own, with no web tools (G8); these say who
 * writes it and what history it gets.
 */

/**
 * Who answers a scheduled note: its recurring question's persona (Jack or Stand), and Jack for anything
 * else. Never the room's own setting, so a room switched to Lift doesn't make its automations Lift
 * (design §11.1: Jack or Stand only)
 */
export async function scheduledPersona(note: Pick<JackMessageRow, "jobKey">): Promise<JackRoomPersonaKey> {
  const id = recurringIdFromJobKey(note.jobKey)
  if (!id) return "jack"
  const question = await prisma.recurringQuestion.findUnique({ where: { id }, select: { persona: true } })
  return question && isRecurringPersona(question.persona) ? question.persona : "jack"
}

/**
 * The rows a scheduled reply's history is built from (design §11.1): the note it answers, and the last
 * note the same job posted before it with that note's answer (the question and its last answer). Never
 * the officers' conversation in the room: a recurring question is the same question each time, and a
 * short history keeps it cheap and keeps what officers said there out of it. A note without a job key
 * gets only itself.
 */
export async function scheduledHistoryRows(roomId: string, note: Pick<JackMessageRow, "id" | "jobKey" | "createdAt">, reply: Pick<JackMessageRow, "id">): Promise<JackMessageRow[]> {
  const ids = [note.id, reply.id]
  if (note.jobKey) {
    const [previous] = await prisma.jackMessage.findMany({
      where: { roomId, kind: "system", scheduled: true, jobKey: note.jobKey, answeredById: { not: null }, createdAt: { lt: note.createdAt } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
      select: { id: true, answeredById: true },
    })
    if (previous?.answeredById) ids.push(previous.id, previous.answeredById)
  }
  // Read again: the note's answeredById was set when this reply took it, after the run read it
  return prisma.jackMessage.findMany({ where: { roomId, id: { in: ids } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: jackMessageInclude })
}
