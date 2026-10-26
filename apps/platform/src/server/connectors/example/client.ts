import { serviceBaseUrl } from "../base-url"
import { defineConnector } from "../define"
import type { ConnectorEnv } from "../types"

/**
 * The template for a service's client and connector, with its fake in `fake/handlers.ts`. It isn't
 * registered in any slot, so it never shows on the Connections page; the tests run it against the fake.
 * A real one keeps the same parts: a plain-fetch client whose base URL comes from serviceBaseUrl(),
 * errors that never carry the key, a timeout on every call, and defineConnector() around it.
 */

export const EXAMPLE_REAL_URL = "https://api.example.com"

/** The longest any one call may take, even when the caller passes its own signal */
export const EXAMPLE_TIMEOUT_MS = 20_000

export class ExampleApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Example API answered ${status} on ${path}`)
    this.name = "ExampleApiError"
  }
}

export function exampleClient(token: string, env: ConnectorEnv = process.env) {
  const base = serviceBaseUrl("example", EXAMPLE_REAL_URL, env)

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    // The caller's headers, plus the key; the caller's signal, plus the timeout
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${token}`)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    const timeout = AbortSignal.timeout(EXAMPLE_TIMEOUT_MS)
    const response = await fetch(`${base}${path}`, { ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
    if (!response.ok) throw new ExampleApiError(response.status, path)
    return (await response.json()) as T
  }

  return {
    ping: (signal?: AbortSignal) => call<{ ok: boolean }>("/v1/ping", { signal }),
    notes: (signal?: AbortSignal) => call<{ notes: string[] }>("/v1/notes", { signal }),
    addNote: (text: string) => call<{ notes: string[] }>("/v1/notes", { method: "POST", body: JSON.stringify({ text }) }),
  }
}

export const exampleConnector = defineConnector({
  id: "example",
  label: "Example",
  requiredEnv: ["EXAMPLE_TOKEN"],
  createClient: (env) => exampleClient(env.EXAMPLE_TOKEN!, env),
  // Works while switched off: it builds its own client instead of calling client()
  async smoke({ signal } = {}) {
    const { notes } = await exampleClient(process.env.EXAMPLE_TOKEN ?? "").notes(signal)
    return { ok: true, summary: `Read ${notes.length} notes` }
  },
})
