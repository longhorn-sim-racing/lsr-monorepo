import { describe, expect, it } from "vitest"
import { DEPARTMENTS, departmentName, officerProfileFromForm, officerProfileSchema, WORKING_ON_MAX } from "./officer-profile.schema"

describe("officerProfileSchema", () => {
  it("takes the roster's departments, a board flag and a one-line note", () => {
    expect(officerProfileSchema.parse({ department: "technology", isBoard: true, workingOn: "  The website,\n  Jack and   payments " })).toEqual({
      department: "technology",
      isBoard: true,
      workingOn: "The website, Jack and payments",
    })
  })

  it("treats blanks as none", () => {
    expect(officerProfileSchema.parse({ department: "", isBoard: false, workingOn: "   " })).toEqual({ department: null, isBoard: false, workingOn: null })
    expect(officerProfileSchema.parse({ department: null, isBoard: false, workingOn: null })).toEqual({ department: null, isBoard: false, workingOn: null })
  })

  it("refuses a department that isn't on the roster, and a note over 160 characters", () => {
    expect(officerProfileSchema.safeParse({ department: "marketing", isBoard: false, workingOn: null }).error?.issues[0].message).toBe("Pick a department from the list.")
    expect(officerProfileSchema.safeParse({ department: null, isBoard: false, workingOn: "x".repeat(WORKING_ON_MAX + 1) }).error?.issues[0].message).toMatch(/160 characters/)
    expect(officerProfileSchema.safeParse({ department: null, isBoard: false, workingOn: "x".repeat(WORKING_ON_MAX) }).success).toBe(true)
  })
})

describe("the departments", () => {
  it("are the About page's six teams", () => {
    expect(DEPARTMENTS.map((d) => d.id).sort()).toEqual(["business", "community", "competition", "executive", "media", "technology"])
    expect(departmentName("media")).toBe("Media")
    expect(departmentName("nope")).toBeNull()
    expect(departmentName(null)).toBeNull()
  })

  it("read from a form, with an unticked board box as false", () => {
    const form = new FormData()
    form.set("department", "competition")
    form.set("workingOn", "Race control")
    expect(officerProfileFromForm(form)).toEqual({ department: "competition", isBoard: false, workingOn: "Race control" })
    form.set("isBoard", "on")
    expect(officerProfileFromForm(form).isBoard).toBe(true)
  })
})
