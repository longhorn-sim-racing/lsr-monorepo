import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"

/**
 * Test helper: an in-memory Claude Files client. It keeps what was uploaded (name, type, bytes), says
 * which ids are still there, and can be made to fail. Ids carry the kind like fakeClaude's stand-ins.
 * The client's own code is tested against the HTTP fake (connectors/anthropic); this is for the code
 * that uses it. Not used by the app.
 */
export function memoryClaudeFiles() {
  const files = new Map<string, { name: string; type: string; bytes: Buffer }>()
  const state = { failUploads: false, failDeletes: false, failChecks: false }
  const calls: string[] = []
  let next = 0
  const client: ClaudeFilesClient = {
    async upload({ name, bytes, type }) {
      calls.push(`upload ${name}`)
      if (state.failUploads) throw new Error("529 overloaded")
      const id = `file_mem_${type === "application/pdf" ? "pdf" : "image"}_${++next}`
      files.set(id, { name, type, bytes: Buffer.from(bytes) })
      return { id }
    },
    async remove(id) {
      calls.push(`delete ${id}`)
      if (state.failDeletes) throw new Error("500 api_error")
      return files.delete(id) ? "deleted" : "gone"
    },
    async visible(ids) {
      calls.push(`check ${ids.join(",")}`)
      if (state.failChecks) throw new Error("503 unavailable")
      return new Set(ids.filter((id) => files.has(id)))
    },
  }
  return { client, files, state, calls }
}
