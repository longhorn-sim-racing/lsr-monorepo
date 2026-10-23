import Anthropic, { toFile } from "@anthropic-ai/sdk"
import { serviceBaseUrl } from "../base-url"
import { defineConnector } from "../define"
import type { ConnectorEnv } from "../types"

/**
 * Claude's Files API (design §5): officers' PDFs and photo copies are uploaded once, when they're
 * registered, so a turn sends a file id instead of the bytes. GA, so it's `client.files.*` with no beta
 * header (SDK 0.133). Uploading, listing and deleting cost nothing.
 *
 * Files belong to the API key's workspace, so ids only ever come from here (JackFile.anthropicFileId,
 * written on the server), never from a browser. The base URL goes through serviceBaseUrl(), so
 * JACK_FAKES points the client at the fake in `fake/handlers.ts`.
 */

export const ANTHROPIC_API_URL = "https://api.anthropic.com"
/** The ConnectorState row and the Connections page's id */
export const CLAUDE_FILES_CONNECTOR = "claude-files"
/** The longest one call may take (each attempt; the SDK retries twice). An upload is at most 25 MB */
export const CLAUDE_FILES_TIMEOUT_MS = 30_000
/** Ids per list call: the API takes at most 100 */
const IDS_PER_LIST = 100

export type ClaudeFilesClient = {
  upload(file: { name: string; bytes: Uint8Array; type: string }, options?: { signal?: AbortSignal }): Promise<{ id: string }>
  /** Deletes a file. One that's already gone (deleted, expired, another workspace's) counts as deleted */
  remove(id: string, options?: { signal?: AbortSignal }): Promise<"deleted" | "gone">
  /** Which of these ids the key's workspace can still see: a deleted or expired file isn't listed */
  visible(ids: string[], options?: { signal?: AbortSignal }): Promise<Set<string>>
}

export function claudeFilesClient(apiKey: string, env: ConnectorEnv = process.env): ClaudeFilesClient {
  const client = new Anthropic({
    apiKey,
    // The same place the Messages client goes (it reads ANTHROPIC_BASE_URL too), unless JACK_FAKES says the fake
    baseURL: serviceBaseUrl("anthropic", env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_API_URL, env),
    timeout: CLAUDE_FILES_TIMEOUT_MS,
    // The global fetch when each call is made, so a test's mounted fakes answer it
    fetch: (input, init) => fetch(input, init),
  })

  return {
    async upload({ name, bytes, type }, { signal } = {}) {
      const file = await toFile(bytes, name, { type })
      const uploaded = await client.files.upload({ file }, { signal })
      return { id: uploaded.id }
    },
    async remove(id, { signal } = {}) {
      try {
        await client.files.delete(id, {}, { signal })
        return "deleted"
      } catch (error) {
        if (error instanceof Anthropic.NotFoundError) return "gone"
        throw error
      }
    },
    async visible(ids, { signal } = {}) {
      const found = new Set<string>()
      const unique = [...new Set(ids)]
      for (let i = 0; i < unique.length; i += IDS_PER_LIST) {
        const page = await client.files.list({ ids: unique.slice(i, i + IDS_PER_LIST) }, { signal })
        for (const file of page.data) found.add(file.id)
      }
      return found
    },
  }
}

/** A 1×1 PNG for the smoke test */
const SMOKE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64")

/**
 * Claude Files on the Connections page. Off until an admin switches it on: until then officers' photos
 * go to Claude as copies inside each request, and PDFs as their text. Deleting files uploaded earlier
 * doesn't need it on (jack/files/claude.ts).
 */
export const claudeFilesConnector = defineConnector({
  id: CLAUDE_FILES_CONNECTOR,
  label: "Claude Files",
  requiredEnv: ["ANTHROPIC_API_KEY"],
  createClient: (env) => claudeFilesClient(env.ANTHROPIC_API_KEY!.trim(), env),
  // Uploads a tiny test image, finds it, and deletes it again (all free); works while switched off
  async smoke({ signal } = {}) {
    const client = claudeFilesClient(process.env.ANTHROPIC_API_KEY?.trim() ?? "")
    const { id } = await client.upload({ name: "jack-smoke-test.png", bytes: SMOKE_PNG, type: "image/png" }, { signal })
    try {
      const found = (await client.visible([id], { signal })).has(id)
      if (!found) return { ok: false, summary: "Uploaded a test file, but the workspace doesn't list it" }
    } finally {
      await client.remove(id, { signal })
    }
    return { ok: true, summary: "Uploaded, found and deleted a test file" }
  },
  async details() {
    return [{ label: "Used for", value: "Photos and PDFs officers attach in Jack's rooms" }]
  },
})
