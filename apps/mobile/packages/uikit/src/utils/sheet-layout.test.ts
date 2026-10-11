import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isLandscapeSize, shouldCapSheetContent, SHEET_CONTENT_MAX_WIDTH, sheetContentCap } from "./sheet-layout.ts"

describe("sheet-layout", () => {
  it("detects landscape by strict width > height", () => {
    assert.equal(isLandscapeSize(1192, 820), true)
    assert.equal(isLandscapeSize(390, 844), false)
    assert.equal(isLandscapeSize(800, 800), false)
  })

  it("caps sheet content from the tablet breakpoint up", () => {
    assert.equal(shouldCapSheetContent(767), false)
    assert.equal(shouldCapSheetContent(768), true)
    assert.equal(shouldCapSheetContent(1192), true)
  })

  it("exposes a centered full-width column cap", () => {
    assert.equal(SHEET_CONTENT_MAX_WIDTH, 640)
    assert.deepEqual(sheetContentCap, { width: "100%", maxWidth: 640, alignSelf: "center" })
  })
})
