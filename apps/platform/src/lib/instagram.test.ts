import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "@/server/connectors/fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "@/server/connectors/instagram/fake/handlers"
import { getProfile, getRecentMedia, InstagramApiError } from "./instagram"

// The feed sync's client against the shared Instagram fake (Jack 2.0 T5), and its base URL
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the feed sync's Instagram client", () => {
  it("reads the profile and the newest posts from the fake when JACK_FAKES names instagram", async () => {
    const fakes = mountFakes([instagramFake])
    expect(await getProfile(INSTAGRAM_FAKE.token)).toMatchObject({ user_id: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username })
    const media = await getRecentMedia(INSTAGRAM_FAKE.token, 3)
    expect(media).toHaveLength(3)
    expect(media[0]).toMatchObject({ id: "18012345678900010", media_type: "IMAGE", permalink: expect.stringContaining("instagram.com/p/") })
    expect(fakes.requests.map((r) => r.path)).toEqual(["/me", "/me/media"])
  })

  it("keeps a stand-in's base path (INSTAGRAM_GRAPH_URL), where it used to drop it", async () => {
    const seen: string[] = []
    vi.stubGlobal("fetch", async (input: URL) => {
      seen.push(input.toString())
      return Response.json({ user_id: "1", username: "x" })
    })
    vi.stubEnv("JACK_FAKES", "")
    vi.stubEnv("INSTAGRAM_GRAPH_URL", "http://127.0.0.1:4555/instagram/")
    await getProfile("t")
    vi.stubEnv("INSTAGRAM_GRAPH_URL", "")
    await getProfile("t")
    expect(seen.map((url) => url.split("?")[0])).toEqual(["http://127.0.0.1:4555/instagram/me", "https://graph.instagram.com/me"])
  })

  it("says the token expired on Meta's code 190", async () => {
    mountFakes([instagramFake])
    await expect(getProfile("not-a-token")).rejects.toMatchObject({ name: "InstagramApiError", expiredToken: true })
    await expect(getProfile("not-a-token")).rejects.toBeInstanceOf(InstagramApiError)
  })
})
