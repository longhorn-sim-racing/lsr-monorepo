"use server"

import { revalidatePath } from "next/cache"
import type { ActionResult } from "@/lib/action-result"
import { createAuditLog } from "@/server/audit/log"
import { requireRole } from "@/server/auth/guards"
import { missingEnv } from "@/server/connectors/define"
import { CONNECTOR_ENTITY } from "@/server/connectors/state"
import { TWITCH_CONNECTOR_ID, twitchAppApi } from "@/server/connectors/twitch/connector"
import { forgetTwitchClubGrant } from "@/server/connectors/twitch/tokens"

/**
 * Disconnects the club's Twitch account (admins only): forgets its grant and revokes the token at
 * Twitch, so nothing reads followers until an admin connects it again. Audited (no tokens).
 */
export async function disconnectTwitchAction(): Promise<ActionResult<{ revoked: boolean }>> {
  let userId: string
  try {
    userId = (await requireRole("admin")).id
  } catch {
    return { ok: false, error: "Only admins can disconnect the club's Twitch account." }
  }
  const grant = await forgetTwitchClubGrant()
  let revoked = false
  if (grant && !missingEnv(["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"]).length) {
    revoked = await twitchAppApi()
      .revoke(grant.accessToken)
      .then(() => true)
      .catch((error: unknown) => {
        console.warn("[twitch] Couldn't revoke the club account's token:", error instanceof Error ? error.message : error)
        return false
      })
  }
  await createAuditLog({ actorUserId: userId, actionType: "DISCONNECT", entityType: CONNECTOR_ENTITY, entityId: TWITCH_CONNECTOR_ID, summary: "Disconnected the club's Twitch account" })
  revalidatePath("/admin/streams")
  revalidatePath("/admin/connections")
  return { ok: true, data: { revoked } }
}
