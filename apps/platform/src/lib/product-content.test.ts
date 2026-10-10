import { describe, expect, it } from "vitest"
import { cleanProductDescription, hasOnDemandBoilerplate, ON_DEMAND_TEXT } from "./product-content"

describe("cleanProductDescription", () => {
  it("cuts Shopify's size guide block without leaving tags open", () => {
    const html =
      '<p>Kit.</p><p><strong class="size-guide-title">Size guide</strong></p><div class="table-responsive"><table><tr><td>S</td></tr></table></div>'
    expect(cleanProductDescription(html)).toBe("<p>Kit.</p>")
  })

  it("keeps a sentence that mentions the size guide when a heading follows", () => {
    const html = '<p>Runs small, <em>see the size guide</em> below.</p><p><strong class="size-guide-title">Size guide</strong></p><table></table>'
    expect(cleanProductDescription(html)).toBe("<p>Runs small, <em>see the size guide</em> below.</p>")
  })

  it("closes anything a mid-sentence cut leaves open", () => {
    expect(cleanProductDescription("<p>Runs small, <em>see the size guide</em> below.</p><table></table>")).toBe(
      "<p>Runs small, <em>see the </em></p>"
    )
    expect(cleanProductDescription('<div class="desc"><p>Intro</p><h3>Size guide</h3><table></table></div>')).toBe(
      '<div class="desc"><p>Intro</p></div>'
    )
  })

  it("drops a tag the cut lands inside, and ignores tags in comments", () => {
    expect(cleanProductDescription('<p>Intro</p><img src="chart.png" alt="Size guide chart"><p>More</p>')).toBe("<p>Intro</p>")
    expect(cleanProductDescription("<!-- <div> --><p>Intro</p><h3>Size guide</h3>")).toBe("<!-- <div> --><p>Intro</p>")
  })

  it("doesn't add closing tags for void elements", () => {
    expect(cleanProductDescription('<p>Line<br>two <img src="x"></p><b>Size guide</b><br>')).toBe('<p>Line<br>two <img src="x"></p>')
  })

  it("removes the on-demand boilerplate and the empty paragraph it leaves", () => {
    expect(cleanProductDescription(`<p>Great shirt.</p><p>${ON_DEMAND_TEXT}</p>`)).toBe("<p>Great shirt.</p>")
  })

  it("leaves other descriptions alone", () => {
    expect(cleanProductDescription("<p>Plain description.</p>")).toBe("<p>Plain description.</p>")
    expect(cleanProductDescription(undefined)).toBe("")
  })
})

describe("hasOnDemandBoilerplate", () => {
  it("finds the boilerplate even across line breaks", () => {
    expect(hasOnDemandBoilerplate(`<p>${ON_DEMAND_TEXT.replace(/ /g, "\n")}</p>`)).toBe(true)
    expect(hasOnDemandBoilerplate("<p>Nope</p>")).toBe(false)
    expect(hasOnDemandBoilerplate(undefined)).toBe(false)
  })
})
