import { describe, expect, it } from "vitest"
import { isScreenshotPath, routeRequest, scaleFor, THUMB_LONG_SIDE, VIEW_LONG_SIDE } from "./renderer"

const page = { navigation: false }

describe("routeRequest", () => {
  it("lets fonts, club photos and the site's own files load", () => {
    expect(routeRequest("https://fonts.googleapis.com/css2?family=Kanit", page)).toEqual({ action: "continue" })
    expect(routeRequest("https://fonts.gstatic.com/s/kanit/v1/x.woff2", page)).toEqual({ action: "continue" })
    expect(routeRequest("https://res.cloudinary.com/daklxjoxr/image/upload/c_limit,w_2000/gallery/x.jpg", page)).toEqual({ action: "continue" })
    expect(routeRequest("https://www.longhornsimracing.org/brand/logos/white_logo.png", page)).toEqual({ action: "continue" })
    expect(routeRequest("data:image/svg+xml;base64,PHN2Zy8+", page)).toEqual({ action: "continue" })
  })

  it("sends the site's photos through its image optimizer", () => {
    expect(routeRequest("https://www.longhornsimracing.org/images/gal_03.jpeg", page)).toEqual({
      action: "continue",
      url: "https://www.longhornsimracing.org/_next/image?url=%2Fimages%2Fgal_03.jpeg&w=2048&q=75",
    })
    expect(routeRequest("https://www.longhornsimracing.org/images/liveries/le-mans-amg.webp", page)).toMatchObject({ url: expect.stringContaining("w=2048") })
  })

  it("blocks other Cloudinary accounts, Cloudinary's fetch delivery, and the rest of the site", () => {
    for (const url of [
      "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      "https://res.cloudinary.com/demo/image/fetch/https://evil.example/x.png?d=secret",
      "https://res.cloudinary.com/daklxjoxr/image/fetch/https://evil.example/x.png",
      "https://res.cloudinary.com/daklxjoxr/image/upload/l_fetch:aHR0cHM6Ly9ldmlsLmV4YW1wbGU=/gallery/x.jpg",
      "https://res.cloudinary.com/daklxjoxr/image/upload/u_fe%74ch:aHR0cHM6/gallery/x.jpg",
      "https://res.cloudinary.com/daklxjoxr/video/upload/clip.mp4",
      "https://www.longhornsimracing.org/_next/image?url=https%3A%2F%2Fres.cloudinary.com%2Fdemo%2Fimage%2Ffetch%2Fhttps%3A%2F%2Fevil.example",
      "https://www.longhornsimracing.org/api/admin/audit-logs",
      "https://www.longhornsimracing.org/",
      "https://res.cloudinary.com/daklxjoxr/image/upload/%E0%A4%A/x.jpg",
    ]) {
      expect(routeRequest(url, page).action, url).toBe("block")
    }
  })

  it("answers jack.assets itself", () => {
    expect(routeRequest("https://jack.assets/qr?text=hi", page)).toEqual({ action: "asset" })
  })

  it("blocks every other host, plain http, ports, logins and navigation", () => {
    for (const url of [
      "https://evil.example/x.png",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x.png",
      "http://res.cloudinary.com/demo/x.jpg",
      "https://res.cloudinary.com:8443/x.jpg",
      "https://user:pw@res.cloudinary.com/x.jpg",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(routeRequest(url, page).action, url).toBe("block")
    }
    expect(routeRequest("https://www.longhornsimracing.org/", { navigation: true }).action).toBe("block")
  })
})

describe("scaleFor", () => {
  it("fits the long side and never scales up", () => {
    expect(scaleFor("slides", VIEW_LONG_SIDE)).toBeCloseTo(1280 / 1920)
    expect(scaleFor("story", VIEW_LONG_SIDE)).toBeCloseTo(1280 / 1920)
    expect(scaleFor("square", VIEW_LONG_SIDE)).toBe(1)
    expect(scaleFor("post", THUMB_LONG_SIDE)).toBeCloseTo(480 / 1350)
  })
})

describe("isScreenshotPath", () => {
  it("allows the site's public pages", () => {
    for (const path of ["/", "/events", "/events/gm-2", "/lone-star-cup", "/lone-star-cup/enter", "/gallery?album=cota", "/apply", "/drivers/gray", "/news/", "/sponsors"]) {
      expect(isScreenshotPath(path), path).toBe(true)
    }
  })

  it("refuses the admin console, sign-in, accounts, the API, other hosts and odd paths", () => {
    for (const path of ["/admin", "/admin/jack", "/api/admin/audit-logs", "/auth/sign-in", "/account", "/check-in/x", "//evil.example", "https://evil.example", "events", "/events\\..","/eventsx", "/ apply"]) {
      expect(isScreenshotPath(path), path).toBe(false)
    }
  })
})
