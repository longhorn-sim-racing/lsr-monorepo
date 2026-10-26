import type { DiscordPost } from "@prisma/client"
import { postingChannelIds } from "./channels"
import { rulePostProblem } from "./rule-runner"

/**
 * A post's last check right before it's sent, by the posts job or an officer's "Send again": its channel
 * is still a posting channel, and a rule's post is still wanted (its rule is on; its event wasn't moved,
 * cancelled or unpublished; the stream is still live). A reason to cancel it instead, or null to send it.
 * `allowed` is the posting channels when the caller read them already
 */
export async function duePostProblem(post: DiscordPost, now: Date, allowed?: readonly string[]): Promise<string | null> {
  if (!(allowed ?? (await postingChannelIds())).includes(post.channelId)) return "Its channel isn't a posting channel anymore."
  return post.source === "rule" ? rulePostProblem(post, now) : null
}
