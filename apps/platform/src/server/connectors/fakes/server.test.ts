import { afterEach, describe, expect, it } from "vitest"
import { exampleFake, EXAMPLE_FAKE_TOKEN } from "../example/fake/handlers"
import { startFakeServer, type FakeServer } from "./server"
import { FakeNetworkError, type FakeService } from "./types"

// The fakes server on a free loopback port: real HTTP on this machine, never the network
let server: FakeServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

const extras: FakeService = {
  id: "extras",
  create: () => [
    {
      method: "GET",
      path: "/cookies",
      handle: () => {
        const headers = new Headers({ "x-fake": "yes" })
        headers.append("set-cookie", "a=1")
        headers.append("set-cookie", "b=2")
        return new Response("plain text", { status: 202, headers })
      },
    },
    {
      method: "GET",
      path: "/drop",
      handle: () => {
        throw new FakeNetworkError()
      },
    },
  ],
}

describe("the fakes server", () => {
  it("serves each fake under its id over HTTP, with request bodies and headers", async () => {
    const lines: string[] = []
    server = await startFakeServer({ services: [exampleFake, extras], port: 0, log: (line) => lines.push(line) })
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const auth = { authorization: `Bearer ${EXAMPLE_FAKE_TOKEN}`, "content-type": "application/json" }
    const created = await fetch(`${server.url}/example/v1/notes`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Book the lounge" }) })
    expect(created.status).toBe(201)
    expect(await (await fetch(`${server.url}/example/v1/notes`, { headers: auth })).json()).toEqual({ notes: ["Book the lounge"] })
    expect((await fetch(`${server.url}/example/v1/notes`)).status).toBe(401)
    expect(lines[0]).toMatch(/^POST \/example\/v1\/notes → 201 \(\d+ ms\)$/)
    expect(lines.join("\n")).not.toContain(EXAMPLE_FAKE_TOKEN)
  })

  it("passes status, headers and every cookie through", async () => {
    server = await startFakeServer({ services: [extras], port: 0 })
    const response = await fetch(`${server.url}/extras/cookies`)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-fake")).toBe("yes")
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"])
    expect(await response.text()).toBe("plain text")
  })

  it("drops the connection for a network error", async () => {
    server = await startFakeServer({ services: [extras], port: 0 })
    await expect(fetch(`${server.url}/extras/drop`)).rejects.toThrow()
  })
})
