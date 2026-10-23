import { createHash } from "node:crypto"
import type { JackFile, JackFileKind } from "@prisma/client"
import { prisma } from "@/server/db"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { ProposalInputError, StaleProposalError } from "../errors"

/**
 * Room files a proposal is built from (results.import, import.rows). Only files of the proposal's own
 * room, and only READY ones (checked, with their sha256 taken at registration). The framework pins the
 * sha256 on the proposal and checks it again before Apply; reading the bytes checks them against it too.
 */

const KIND_NAME: Record<JackFileKind, string> = {
  IMAGE: "a photo",
  PDF: "a PDF",
  SPREADSHEET: "a spreadsheet",
  CSV: "a CSV file",
  JSON: "a JSON file",
  TEXT: "a text file",
  DOCUMENT: "a Word document",
  TRANSCRIPT: "a transcript",
  OTHER: "a file",
}

export type RoomFile = Pick<JackFile, "id" | "roomId" | "filename" | "kind" | "status" | "sha256" | "sizeBytes" | "storagePath" | "text" | "textStatus">

const SELECT = { id: true, roomId: true, filename: true, kind: true, status: true, sha256: true, sizeBytes: true, storagePath: true, text: true, textStatus: true } as const

/** A READY file of this room, of one of `kinds`; ProposalInputError (for the model to fix) otherwise */
export async function roomFile(fileId: string, roomId: string, kinds: JackFileKind[], needed: string): Promise<RoomFile & { sha256: string }> {
  const file = await prisma.jackFile.findUnique({ where: { id: fileId }, select: SELECT })
  if (!file || file.roomId !== roomId) throw new ProposalInputError(`There's no file ${fileId} in this room. Use the id of a file attached in this room.`)
  if (file.status === "UPLOADING") throw new ProposalInputError(`${file.filename} is still uploading. Try again once it's attached.`)
  if (file.status !== "READY" || !file.sha256) throw new ProposalInputError(`${file.filename} couldn't be read when it was attached, so it can't be used.`)
  if (!kinds.includes(file.kind)) throw new ProposalInputError(`${file.filename} is ${KIND_NAME[file.kind]}; this needs ${needed}.`)
  return { ...file, sha256: file.sha256 }
}

/**
 * The file's bytes from the store, checked against the sha256 taken when it was attached. At apply time
 * a missing or changed object is stale (StaleProposalError); at propose time it's an input error
 */
export async function roomFileBytes(file: Pick<RoomFile, "filename" | "storagePath" | "sha256">, when: "propose" | "apply", store: JackFileStore = jackFileStore()): Promise<Buffer> {
  const fail = (message: string) => (when === "apply" ? new StaleProposalError(message) : new ProposalInputError(message))
  const body = await store.get(file.storagePath)
  if (!body) throw fail(`${file.filename} is no longer in the room's storage. Attach it again.`)
  if (createHash("sha256").update(body).digest("hex") !== file.sha256) throw fail(`${file.filename} in storage isn't the file that was attached. Attach it again.`)
  return body
}
