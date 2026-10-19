import { test } from "node:test"
import assert from "node:assert/strict"
import { matchSupportedLocale, resolveLocale, FALLBACK_LOCALE } from "./locale-resolve.ts"

test("matchSupportedLocale maps ru variants to ru", () => {
  assert.equal(matchSupportedLocale("ru"), "ru")
  assert.equal(matchSupportedLocale("ru-RU"), "ru")
  assert.equal(matchSupportedLocale("RU"), "ru") // case-insensitive
})

test("matchSupportedLocale maps en variants to en", () => {
  assert.equal(matchSupportedLocale("en"), "en")
  assert.equal(matchSupportedLocale("en-US"), "en")
  assert.equal(matchSupportedLocale("EN-GB"), "en") // case-insensitive
})

test("matchSupportedLocale returns null for unsupported languages", () => {
  assert.equal(matchSupportedLocale("fr-FR"), null)
  assert.equal(matchSupportedLocale("ja"), null)
  assert.equal(matchSupportedLocale("es-ES"), null)
})

test("resolveLocale: explicit preference always wins over device tags", () => {
  assert.equal(resolveLocale("en", ["ru-RU"]), "en")
  assert.equal(resolveLocale("ru", ["en-US"]), "ru")
})

test("resolveLocale: system preference picks first supported device tag", () => {
  assert.equal(resolveLocale("system", ["fr-FR", "ru-RU", "en-US"]), "ru")
  assert.equal(resolveLocale("system", ["en-US", "ru-RU"]), "en")
})

test("resolveLocale: system preference falls back when nothing matches", () => {
  assert.equal(resolveLocale("system", ["fr-FR", "ja-JP"]), FALLBACK_LOCALE)
  assert.equal(resolveLocale("system", []), FALLBACK_LOCALE)
})
