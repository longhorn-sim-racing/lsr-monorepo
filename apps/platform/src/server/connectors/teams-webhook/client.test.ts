import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ connectorEnabled: vi.fn(), recordConnectorError: vi.fn(), recordConnectorSync: vi.fn() }))
vi.mock("../state", () => ({ ...state, readConnectorState: vi.fn(async () => null) }))

import { mountFakes, type MountedFakes } from "../fakes/testing"
import { teamsWebhookClient, TeamsWebhookError, webhookHost, webhookUrlProblem } from "./client"
import { postRecorded, SMOKE_CARD, teamsWebhookConnector } from "./connector"
import { teamsWebhookFake } from "./fake/handlers"

/** A flow's URL: the `sig` is its secret (built from pieces, it's never a real one) */
const SIG = "fakeSig" + "0123456789abcdefABCDEF"
const URL_ = `https://prod-00.westus.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const card = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { type: "AdaptiveCard", version: "1.2", body: [] } }] }

afterEach(() => {
  vi.unstubAllGlobals()
})

async function cards(fakes: MountedFakes) {
  return ((await (await fetch(`${fakes.origin}/teams-webhook/_fake/cards`)).json()) as { cards: { path: string }[] }).cards
}

describe("the Teams webhook client against its fake", () => {
  it("posts the card to the flow's path and query, with no auth header", async () => {
    const fakes = mountFakes([teamsWebhookFake])
    expect(await teamsWebhookClient(URL_).post(card)).toEqual({ status: 202 })
    const [request] = fakes.requests
    expect(request.path).toBe("/workflows/0123456789abcdef/triggers/manual/paths/invoke")
    expect(new URL(request.url).searchParams.get("sig")).toBe(SIG)
    expect(request.headers.get("authorization")).toBeNull()
    expect(JSON.parse(request.body)).toEqual(card)
    expect(await cards(fakes)).toHaveLength(1)
  })

  it("throws the status and Workflows' code on a refusal, never the URL", async () => {
    const fakes = mountFakes([teamsWebhookFake])
    await fetch(`${fakes.origin}/teams-webhook/_fake/fail`, { method: "POST", body: JSON.stringify({ status: 429 }) })
    const error = await teamsWebhookClient(URL_).post(card).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TeamsWebhookError)
    expect((error as TeamsWebhookError).status).toBe(429)
    expect((error as Error).message).toBe("The Teams webhook answered 429 (FakeFailure)")
    expect((error as Error).message).not.toMatch(/sig|workflows|logic\.azure/)

    const bad = await teamsWebhookClient(URL_).post({ type: "message", attachments: [] }).catch((e: unknown) => e)
    expect((bad as Error).message).toBe("The Teams webhook answered 400 (InvalidRequestContent)")
  })

  it("is refused by the fake without the flow's signature, as Logic Apps refuses it", async () => {
    mountFakes([teamsWebhookFake])
    const unsigned = URL_.replace(/&sig=.*$/, "")
    await expect(teamsWebhookClient(unsigned).post(card)).rejects.toThrow("answered 401")
  })
})

describe("webhook URLs", () => {
  it("must be a Workflows webhook on https", () => {
    expect(webhookUrlProblem(URL_)).toBeNull()
    expect(webhookUrlProblem("https://default1234.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x")).toBeNull()
    expect(webhookUrlProblem(undefined)).toMatch(/isn't set/)
    expect(webhookUrlProblem("not a url")).toMatch(/isn't a URL/)
    expect(webhookUrlProblem(URL_.replace("https:", "http:"))).toMatch(/https/)
    expect(webhookUrlProblem("https://example.com/workflows/abc")).toMatch(/logic\.azure\.com/)
    expect(webhookUrlProblem("https://outlook.office.com/webhook/abc")).toMatch(/Workflows/)
    expect(webhookUrlProblem("https://prod-00.westus.logic.azure.com/other")).toMatch(/\/workflows\//)
    // The problems never repeat the URL
    expect(webhookUrlProblem("https://evil.example/workflows/x?sig=secret")).not.toContain("secret")
  })

  it("show only their host", () => {
    expect(webhookHost(URL_)).toBe("prod-00.westus.logic.azure.com")
    expect(webhookHost("nope")).toBeNull()
  })
})

describe("the teams-webhook connector", () => {
  it("has no client until it's set up and switched on, and none for a URL that isn't a webhook", async () => {
    vi.stubEnv("TEAMS_WEBHOOK_URL", "")
    state.connectorEnabled.mockResolvedValue(true)
    expect(await teamsWebhookConnector.client()).toBeNull()
    vi.stubEnv("TEAMS_WEBHOOK_URL", URL_)
    state.connectorEnabled.mockResolvedValue(false)
    expect(await teamsWebhookConnector.client()).toBeNull()
    state.connectorEnabled.mockResolvedValue(true)
    expect((await teamsWebhookConnector.client())?.host).toBe("prod-00.westus.logic.azure.com")
    vi.stubEnv("TEAMS_WEBHOOK_URL", "https://example.com/hook")
    await expect(teamsWebhookConnector.client()).rejects.toThrow(/isn't a Workflows webhook/)
  })

  it("smoke-tests by posting one test card, while switched off", async () => {
    const fakes = mountFakes([teamsWebhookFake])
    vi.stubEnv("TEAMS_WEBHOOK_URL", URL_)
    state.connectorEnabled.mockResolvedValue(false)
    state.recordConnectorSync.mockResolvedValue(undefined)
    expect(await teamsWebhookConnector.smoke!()).toEqual({ ok: true, summary: "Posted a test card through prod-00.westus.logic.azure.com (answered 202)" })
    expect(JSON.parse(fakes.requests[0].body)).toEqual(SMOKE_CARD)
    expect(state.recordConnectorSync).toHaveBeenCalledWith("teams-webhook")
    vi.stubEnv("TEAMS_WEBHOOK_URL", "")
    expect(await teamsWebhookConnector.smoke!()).toEqual({ ok: false, summary: "TEAMS_WEBHOOK_URL isn't set." })
  })

  it("records each post's outcome on the connector, without the URL, and still throws a failure", async () => {
    const fakes = mountFakes([teamsWebhookFake])
    state.recordConnectorSync.mockResolvedValue(undefined)
    state.recordConnectorError.mockRejectedValue(new Error("database down"))
    const client = teamsWebhookClient(URL_)
    expect(await postRecorded(client, card)).toEqual({ status: 202 })
    expect(state.recordConnectorSync).toHaveBeenCalledWith("teams-webhook")

    await fetch(`${fakes.origin}/teams-webhook/_fake/fail`, { method: "POST", body: JSON.stringify({ status: 404 }) })
    // Recording failing too never hides the post's own error
    const error = await postRecorded(client, card).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TeamsWebhookError)
    expect(state.recordConnectorError).toHaveBeenCalledWith("teams-webhook", error)
    expect(String((error as Error).message)).not.toContain(SIG)
  })
})
