import { describe, expect, it } from "vitest"
import { parseRoundTitle } from "./rounds"

describe("parseRoundTitle", () => {
  it("reads the round, track and note", () => {
    expect(parseRoundTitle("Lone Star Cup S3 Round 7 @ Mount Panorama (Halloween Night Race)", 6)).toEqual({
      short: "R7",
      name: "Round 7",
      number: "7",
      track: "Mount Panorama",
      note: "Halloween Night Race",
      night: true,
      final: false,
    })
  })

  it("recognises the final", () => {
    expect(parseRoundTitle("Lone Star Cup S2 FINAL Round @ Nürburgring", 9)).toMatchObject({
      short: "F",
      name: "Final round",
      number: null,
      track: "Nürburgring",
      final: true,
    })
  })

  it("keeps half rounds and falls back to the position when there's no number", () => {
    expect(parseRoundTitle("LSC Round 3.5 @ Okayama", 2)).toMatchObject({ short: "R3.5", track: "Okayama" })
    expect(parseRoundTitle("Season opener @ Daytona", 0)).toMatchObject({ short: "R1", name: "Round 1", track: "Daytona" })
  })

  it("reads a track without an @", () => {
    expect(parseRoundTitle("Round 4: Brands Hatch", 3)).toMatchObject({ short: "R4", track: "Brands Hatch", note: null, night: false })
  })
})
