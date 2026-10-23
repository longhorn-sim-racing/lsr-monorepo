import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { GRAPH_FAKE } from "./fake/fixtures"
import { microsoftGraphFake } from "./fake/handlers"
import { GraphApiError, GraphAuthError, graphClient, graphCredentialsFromEnv } from "./graph"

const credentials = { tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }
const client = () => graphClient(credentials, { retryDelayMs: 0 })
const hook = (fakes: MountedFakes, path: string, body: unknown = {}) => fetch(`${fakes.origin}/microsoft-graph/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Graph client against the fake", () => {
  it("signs in with client credentials for Graph's .default scope, then calls Graph with the token", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    const drive = await client().get<{ name: string }>(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}`)
    expect(drive.name).toBe("Documents")
    const signIn = fakes.requests.find((r) => r.path.endsWith("/oauth2/v2.0/token"))!
    expect(signIn.path).toBe(`/${GRAPH_FAKE.tenantId}/oauth2/v2.0/token`)
    expect(Object.fromEntries(new URLSearchParams(signIn.body))).toEqual({ grant_type: "client_credentials", client_id: GRAPH_FAKE.clientId, client_secret: GRAPH_FAKE.clientSecret, scope: "https://graph.microsoft.com/.default" })
    expect(fakes.requests.at(-1)!.headers.get("authorization")).toMatch(/^Bearer fixture\.graph\./)
  })

  it("fails sign-in with Microsoft's code and the first sentence, never the secret", async () => {
    mountFakes([microsoftGraphFake])
    const error = await graphClient({ ...credentials, clientSecret: "a-wrong-secret-value" })
      .get("/drives/x")
      .catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(GraphAuthError)
    expect(error).toMatchObject({ status: 401, code: "invalid_client" })
    expect((error as Error).message).toContain("AADSTS7000215")
    expect((error as Error).message).not.toMatch(/a-wrong-secret-value|Trace ID/)
  })

  it("waits out Graph's Retry-After on 429 and tries again", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    await hook(fakes, "config", { throttle: { count: 2, retryAfter: 0 } })
    expect((await client().get<{ id: string }>(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}`)).id).toBe(GRAPH_FAKE.driveId)
  })

  it("signs in again once when its token stops working", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    const graph = client()
    await graph.get(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}`)
    await hook(fakes, "expire-tokens")
    await graph.get(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}`)
    expect(fakes.requests.filter((r) => r.path.endsWith("/token"))).toHaveLength(2)
  })

  it("says when IT revoked the grant: 403 accessDenied, not retried", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    await hook(fakes, "config", { sitesGranted: false })
    await expect(client().get(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}`)).rejects.toMatchObject({ name: "GraphApiError", status: 403, code: "accessDenied" })
  })

  it("follows Graph's own next links, and refuses one pointing anywhere else (the token never leaves)", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    await hook(fakes, "config", { pageSize: 3 })
    const graph = client()
    const first = await graph.page<{ id: string }>(`/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}/root/delta`)
    expect(first.nextLink).toMatch(/^http:\/\/127\.0\.0\.1:3999\/microsoft-graph\/v1\.0\//)
    const second = await graph.page<{ id: string }>(first.nextLink!)
    expect(second.value.length).toBeGreaterThan(0)
    await expect(graph.page("https://evil.example/v1.0/drives/x")).rejects.toThrow("points somewhere else")
    expect(fakes.requests.some((r) => r.url.includes("evil.example"))).toBe(false)
  })

  it("downloads a file through Graph's pre-signed link, without sending the token there", async () => {
    const fakes = mountFakes([microsoftGraphFake])
    const body = await client().download(GRAPH_FAKE.driveId, "sp-rules", 1_000_000)
    expect(body?.toString()).toContain("# Rules draft (fixture)")
    const download = fakes.requests.find((r) => r.path.startsWith("/dl/"))!
    expect(download.headers.has("authorization")).toBe(false)
    expect(await client().download(GRAPH_FAKE.driveId, "sp-rules", 10)).toBeNull()
  })

  it("names the path in errors, not the token", async () => {
    mountFakes([microsoftGraphFake])
    const error = await client()
      .get("/drives/nope")
      .catch((e: unknown) => e as GraphApiError)
    expect(error).toBeInstanceOf(GraphApiError)
    expect(error.message).toBe("Microsoft Graph answered 404 (itemNotFound) on /v1.0/drives/nope")
  })
})

describe("graphCredentialsFromEnv", () => {
  it("needs all three", () => {
    expect(graphCredentialsFromEnv({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s" })).toEqual({ tenantId: "t", clientId: "c", clientSecret: "s" })
    expect(graphCredentialsFromEnv({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c" })).toBeNull()
  })
})
