"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { createAuditLog } from "@/server/audit/log"
import { requireOfficer } from "@/server/auth/guards"
import { instagramGraph, InstagramGraphError } from "@/server/connectors/instagram/graph"
import { instagramPublisher } from "@/server/connectors/instagram/publish"
import { INSTAGRAM_PUBLISH_ID, instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { forgetPublishToken, publishAccount, savePublishToken } from "@/server/connectors/instagram/publish-token"
import { CONNECTOR_ENTITY } from "@/server/connectors/state"
import { prisma } from "@/server/db"
import { finishInstagramPublishes, publishDeps } from "@/server/jack/publish/instagram"
import { readInstagramAccess } from "@/server/services/instagram.service"

/**
 * Content → Instagram's Publishing section (#188, design §12.6). Only admins connect or disconnect the
 * publishing token (it can post publicly as the club); any officer can check a waiting post now. The
 * token is checked with Instagram before it's stored, and never logged, audited or sent back.
 */

const ADMINS_ONLY = "Only admins can connect or disconnect Instagram publishing."
const PAGE = "/admin/instagram"

async function requireAdminAction(): Promise<{ id: string; displayName: string } | null> {
  const officer = await requireOfficer()
  const admin = await prisma.userRole.count({ where: { userId: officer.id, role: { key: "admin" } } })
  return admin > 0 ? { id: officer.id, displayName: officer.displayName } : null
}

const tokenSchema = z.string().trim().min(20, "Paste the whole token").max(2_000, "That's longer than any Instagram token")

/**
 * Stores a publishing token an admin pasted, after checking with Instagram whose it is and that it can
 * publish (reading the day's quota needs instagram_business_content_publish). It must be the club's
 * account (the feed's, when that's connected) and not the feed's own token: publishing gets its own app.
 */
export async function connectInstagramPublishing(token: string): Promise<ActionResult<{ username: string }>> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const parsed = tokenSchema.safeParse(token)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const feed = await readInstagramAccess()
  if (feed?.token === parsed.data) return { ok: false, error: "That's the feed's own token (Admin → Instagram above). Publishing uses a token from its own Meta app, with instagram_business_content_publish, so the feed's token can never post." }

  let account: { userId: string; username: string }
  try {
    const publisher = instagramPublisher(instagramGraph(parsed.data), "me")
    account = await publisher.account()
    await instagramPublisher(instagramGraph(parsed.data), account.userId).quota()
  } catch (error) {
    if (error instanceof InstagramGraphError && error.missingPermission) return { ok: false, error: "That token can't publish: generate it with instagram_business_content_publish (and instagram_business_basic) in the publishing app, then paste it again." }
    if (error instanceof InstagramGraphError && error.expiredToken) return { ok: false, error: "Instagram didn't accept that token (expired or revoked). Generate a new one and paste the whole thing." }
    return { ok: false, error: "Instagram didn't accept that token. Copy it again from the Meta dashboard and paste the whole thing." }
  }
  if (feed?.userId && feed.userId !== account.userId) {
    return { ok: false, error: `That token is for @${account.username}, but the club's feed is @${feed.username ?? "another account"}. Generate it signed in as the club account.` }
  }

  await savePublishToken({ token: parsed.data, userId: account.userId, username: account.username, connectedById: admin.id })
  await createAuditLog({
    actorUserId: admin.id,
    actionType: "CONNECT",
    entityType: CONNECTOR_ENTITY,
    entityId: INSTAGRAM_PUBLISH_ID,
    summary: `Connected Instagram publishing for @${account.username}`,
    after: { username: account.username, userId: account.userId },
  })
  revalidatePath(PAGE)
  revalidatePath("/admin/connections")
  return { ok: true, data: { username: account.username } }
}

/** Forgets the publishing token. What it posted stays on Instagram and in the history */
export async function disconnectInstagramPublishing(): Promise<ActionResult> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const before = await publishAccount()
  if (!before.connected) return { ok: true }
  await forgetPublishToken()
  await createAuditLog({
    actorUserId: admin.id,
    actionType: "DISCONNECT",
    entityType: CONNECTOR_ENTITY,
    entityId: INSTAGRAM_PUBLISH_ID,
    summary: `Disconnected Instagram publishing${before.username ? ` (@${before.username})` : ""}`,
    before: { username: before.username ?? null },
  })
  revalidatePath(PAGE)
  revalidatePath("/admin/connections")
  return { ok: true }
}

const idSchema = z.uuid()

/**
 * Checks a post still on its way to Instagram now, instead of waiting for the follow-up job: the same
 * steps (the container's status first, so it's never posted twice). Its outcome goes to its room as a
 * note
 */
export async function checkInstagramPublishNow(id: string): Promise<ActionResult<{ status: string }>> {
  await requireOfficer()
  if (!idSchema.safeParse(id).success) return { ok: false, error: "That post isn't in the history. Reload the page." }
  const client = await instagramPublishConnector.client()
  if (!client) return { ok: false, error: "Instagram publishing isn't connected (System → Connections), so it can't be checked." }
  const counts = await finishInstagramPublishes(publishDeps(client), { deadline: Date.now() + 40_000, ids: [id], waitMs: 15_000 })
  revalidatePath(PAGE)
  if (counts.busy) return { ok: false, error: "It's being handled right now (an apply or the follow-up job). Check again in a minute." }
  if (counts.errors.length) return { ok: false, error: `Instagram didn't answer the check: ${counts.errors[0]}` }
  const row = await prisma.instagramPublish.findUnique({ where: { id }, select: { status: true } })
  return { ok: true, data: { status: row?.status ?? "failed" } }
}
