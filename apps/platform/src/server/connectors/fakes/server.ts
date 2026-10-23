import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { redactSecrets } from "@/lib/redact"
import { createFakeRouter } from "./router"
import { FakeNetworkError, type FakeService } from "./types"

export type FakeServer = {
  /** e.g. "http://127.0.0.1:3999" */
  url: string
  close(): Promise<void>
}

export type FakeServerOptions = {
  services: readonly FakeService[]
  /** Default 3999; 0 picks a free port */
  port?: number
  /** Always a loopback address; default 127.0.0.1 */
  host?: "127.0.0.1" | "localhost" | "::1"
  /**
   * One line per request (method, path, status, time). Never the query string, headers or bodies, and a
   * path segment that looks like a key is masked: a client in fake mode still sends its real key, in
   * `?access_token=`, `?key=` or a webhook link's path. Default: none
   */
  log?: (line: string) => void
}

/** The request's path for the log, without its query string and with key-like segments masked */
function logPath(rawUrl: string | undefined): string {
  let path: string
  try {
    path = new URL(rawUrl ?? "/", "http://fakes.local").pathname
  } catch {
    path = (rawUrl ?? "/").split(/[?#]/)[0]
  }
  return path
    .split("/")
    .map((segment) => redactSecrets(segment))
    .join("/")
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const method = req.method ?? "GET"
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = method === "GET" || method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks)
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body })
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) headers["set-cookie"] = cookies
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}

/**
 * The local fakes server (`pnpm jack:fakes`): every fake mounted under its id on one loopback port.
 * Clients reach it through serviceBaseUrl() when JACK_FAKES is set.
 */
export async function startFakeServer({ services, port = 3999, host = "127.0.0.1", log }: FakeServerOptions): Promise<FakeServer> {
  const router = createFakeRouter(services)
  const server = createServer((req, res) => {
    const started = Date.now()
    const origin = `http://${req.headers.host ?? (host === "::1" ? `[::1]:${port}` : `${host}:${port}`)}`
    const path = logPath(req.url)
    void (async () => {
      try {
        const response = await router(await toRequest(req, origin))
        await send(res, response)
        log?.(`${req.method} ${path} → ${response.status} (${Date.now() - started} ms)`)
      } catch (error) {
        if (error instanceof FakeNetworkError) {
          log?.(`${req.method} ${path} → dropped (${redactSecrets(error.message)})`)
          req.socket.destroy()
          return
        }
        log?.(`${req.method} ${path} → 500 (${redactSecrets(error instanceof Error ? error.message : String(error))})`)
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ fake: true, error: "The fakes server failed on this request" }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const shown = address.family === "IPv6" ? `[${address.address}]` : address.address

  return {
    url: `http://${shown}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
