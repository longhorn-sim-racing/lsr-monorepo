import { describe, expect, it } from "vitest"
import { uploadedVideo, videoSource, youTubeId } from "./featured-video"

describe("youTubeId", () => {
  it("reads watch, youtu.be, embed, shorts and live links", () => {
    expect(youTubeId("https://www.youtube.com/watch?v=fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://m.youtube.com/watch?v=fbS2ExGupLU&t=42s")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://music.youtube.com/watch?v=fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://WWW.YouTube.com/watch?v=fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://youtu.be/fbS2ExGupLU?si=abc")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://www.youtube.com/embed/fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://www.youtube-nocookie.com/embed/fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://youtube.com/shorts/fbS2ExGupLU")).toBe("fbS2ExGupLU")
    expect(youTubeId("https://www.youtube.com/live/fbS2ExGupLU")).toBe("fbS2ExGupLU")
  })

  it("turns down other sites, channels and broken ids", () => {
    expect(youTubeId("https://example.com/embed/fbS2ExGupLU")).toBeNull()
    expect(youTubeId("https://notyoutube.com/watch?v=fbS2ExGupLU")).toBeNull()
    expect(youTubeId("https://www.youtube.com/@longhornsimracing")).toBeNull()
    expect(youTubeId("https://www.youtube.com/watch?v=short")).toBeNull()
    expect(youTubeId("not a link")).toBeNull()
  })
})

describe("uploadedVideo", () => {
  it("plays an upload as MP4 with a poster frame, whatever it was uploaded as", () => {
    expect(uploadedVideo("https://res.cloudinary.com/daklxjoxr/video/upload/v1791936839/abc123.mkv")).toEqual({
      src: "https://res.cloudinary.com/daklxjoxr/video/upload/q_auto/v1791936839/abc123.mp4",
      poster: "https://res.cloudinary.com/daklxjoxr/video/upload/so_auto,c_limit,w_1280,q_auto/v1791936839/abc123.jpg",
    })
  })

  it("keeps a folder in the id", () => {
    expect(uploadedVideo("https://res.cloudinary.com/demo/video/upload/v1/lsr/videos/clip.mov")?.src).toBe(
      "https://res.cloudinary.com/demo/video/upload/q_auto/v1/lsr/videos/clip.mp4",
    )
  })

  it("turns down images, links that already transform, and other hosts", () => {
    expect(uploadedVideo("https://res.cloudinary.com/demo/image/upload/v1/photo.jpg")).toBeNull()
    expect(uploadedVideo("https://res.cloudinary.com/demo/video/upload/q_auto/v1/clip.mp4")).toBeNull()
    expect(uploadedVideo("https://example.com/demo/video/upload/v1/clip.mp4")).toBeNull()
    expect(uploadedVideo("http://res.cloudinary.com/demo/video/upload/v1/clip.mp4")).toBeNull()
  })
})

describe("videoSource", () => {
  it("tells YouTube links from uploads", () => {
    expect(videoSource("https://youtu.be/fbS2ExGupLU")).toEqual({ kind: "youtube", id: "fbS2ExGupLU" })
    expect(videoSource("https://res.cloudinary.com/demo/video/upload/v1/clip.mkv")?.kind).toBe("upload")
    expect(videoSource("https://vimeo.com/123456")).toBeNull()
  })
})
