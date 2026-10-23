import type { Prisma } from "@prisma/client"
import { MAX_FILES_PER_MESSAGE } from "@/lib/jack/files"
import { prisma } from "@/server/db"

/**
 * Posting a message with files (design §5): the files must be the poster's own uploads, in this room,
 * READY and not posted with another message. Checked before the message is saved (for a clear
 * error), and again inside the transaction that saves it, so two posts can't claim the same file.
 */

export class AttachmentError extends Error {}

/** What's wrong with the files an officer is posting, or null when they can all go */
export async function attachmentProblem(roomId: string, officerId: string, fileIds: string[]): Promise<string | null> {
  if (!fileIds.length) return null
  if (fileIds.length > MAX_FILES_PER_MESSAGE) return `Up to ${MAX_FILES_PER_MESSAGE} files per message.`
  if (new Set(fileIds).size !== fileIds.length) return "The same file is attached twice."
  const files = await prisma.jackFile.findMany({
    where: { id: { in: fileIds } },
    select: { id: true, filename: true, roomId: true, uploadedById: true, status: true, messageId: true },
  })
  for (const id of fileIds) {
    const file = files.find((f) => f.id === id)
    if (!file || file.roomId !== roomId) return "A file you attached is gone. Remove it and attach it again."
    if (file.uploadedById !== officerId) return `${file.filename} was attached by another officer.`
    if (file.messageId) return `${file.filename} is already posted.`
    if (file.status === "UPLOADING") return `${file.filename} is still uploading.`
    if (file.status === "FAILED") return `${file.filename} couldn't be read. Remove it, then send.`
  }
  return null
}

/** Links the files to the message, in the order given. Throws AttachmentError (rolling the transaction back) when one can't be claimed */
export async function linkAttachments(tx: Prisma.TransactionClient, { messageId, roomId, officerId, fileIds }: { messageId: string; roomId: string; officerId: string; fileIds: string[] }) {
  for (const [position, id] of fileIds.entries()) {
    const { count } = await tx.jackFile.updateMany({
      where: { id, roomId, uploadedById: officerId, status: "READY", messageId: null },
      data: { messageId, position },
    })
    if (count !== 1) throw new AttachmentError("One of the files changed while sending (posted, removed or still uploading). Check the files and send again.")
  }
}
