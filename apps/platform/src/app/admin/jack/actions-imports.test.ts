import { expect, it, vi } from "vitest"

/*
 * The room's server actions live in one module, and whatever it imports loads on every action's cold
 * start. The file parsers (pdf.js, exceljs, mammoth) and sharp belong to the register route only.
 */
const loaded = vi.hoisted(() => [] as string[])
vi.mock("@/server/jack/files/extract", () => {
  loaded.push("extract")
  return {}
})
vi.mock("@/server/jack/files/images", () => {
  loaded.push("images")
  return {}
})
vi.mock("@/server/jack/files/register", () => {
  loaded.push("register")
  return {}
})
vi.mock("@/server/db", () => ({ prisma: {} }))

it("the room's server actions never load the file parsers", async () => {
  await import("./actions")
  expect(loaded).toEqual([])
})
