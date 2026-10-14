import { describe, expect, it } from "vitest"
import { adminThemeCookie, parseAdminTheme } from "./admin-theme"

describe("parseAdminTheme", () => {
  it("is dark only when the cookie says so", () => {
    expect(parseAdminTheme("dark")).toBe("dark")
    expect(parseAdminTheme("light")).toBe("light")
    expect(parseAdminTheme(undefined)).toBe("light")
    expect(parseAdminTheme("DARK")).toBe("light")
    expect(parseAdminTheme("")).toBe("light")
  })
})

describe("adminThemeCookie", () => {
  it("is scoped to admin pages and lasts a year", () => {
    expect(adminThemeCookie("dark")).toBe("lsr-admin-theme=dark; Path=/admin; Max-Age=31536000; SameSite=Lax")
  })
})
