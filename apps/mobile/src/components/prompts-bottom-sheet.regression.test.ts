import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Промпты сессии (опросы/подтверждения) — bottom-sheet поверх дока:
// закреплены снизу с отступом как у поля ввода, высота ужата 70% экрана,
// переполнение скроллится внутри карточки. Вопрос — фиксированный заголовок,
// скроллится только список вариантов. Футер с кнопками — вне скролла.
//
// Регрессия: раньше оверлей тянулся через top:0/bottom:0 с лимитом 60%,
// а текст вопроса лежал ВНУТРИ ScrollView вместе с вариантами — при длинном
// списке вопрос уезжал вниз за край экрана вместе с карточкой.
// RN-компоненты нельзя отрендерить в node:test, поэтому тест читает исходники
// и проверяет маркеры (паттерн wide-content-scroll/container-layout тестов).
//
// Карта после рефакторинга PR15: оверлей — src/components/session/prompt-overlay,
// стиль — app/session/styles.ts, карточки — packages/uikit/src/components/chat/*.

function readAppSource(relativePath: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, relativePath), "utf8")
}

function readKitSource(relativePath: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, "../../packages/uikit/src", relativePath), "utf8")
}

test("prompt overlay is bottom-anchored and capped at 70% of window height", () => {
  const src = readAppSource("./session/prompt-overlay/index.tsx")
  assert.match(src, /maxHeight:\s*promptOverlayMaxHeight\(windowHeight\)/, "overlay height must source promptOverlayMaxHeight(windowHeight)")
  assert.doesNotMatch(src, /windowHeight\s*\*\s*0\.6/, "old 60% cap must be gone")
  const styleSrc = readAppSource("../../app/session/styles.ts")
  const block = styleSrc.match(/promptOverlay:\s*\{[^}]*\}/s)?.[0]
  assert.ok(block, "promptOverlay style block must exist in app/session/styles.ts")
  assert.doesNotMatch(block, /top:\s*0/, "overlay must not pin top:0 — it grows upward from bottom:0")
  assert.match(block, /bottom:\s*0/, "overlay must stay anchored to bottom:0")
})

test("prompt overlay insets match the composer field", () => {
  const src = readAppSource("./session/prompt-overlay/index.tsx")
  assert.match(src, /paddingTop:\s*COMPOSER_PADDING/, "overlay top inset must mirror the input container")
  assert.match(
    src,
    /paddingBottom:\s*Math\.max\(COMPOSER_PADDING,\s*insets\.bottom\)/,
    "overlay bottom inset must mirror the dock/input safe-area padding via COMPOSER_PADDING",
  )
  assert.match(src, /paddingHorizontal:\s*COMPOSER_PADDING/, "overlay side insets must mirror the input container")
})

test("question renders as a fixed header, only the options list scrolls", () => {
  const src = readKitSource("components/chat/question-prompt/index.tsx")
  assert.match(src, /testID="question-options-scroll"/, "options ScrollView needs a Maestro testID")
  const questionAt = src.indexOf("{q.question}")
  const scrollAt = src.indexOf("<ScrollView")
  assert.ok(questionAt !== -1 && scrollAt !== -1, "both the question text and the ScrollView must exist")
  assert.ok(questionAt < scrollAt, "question text must render BEFORE the ScrollView (fixed header, not scrolled content)")
  const scrollBlock = src.slice(scrollAt, src.indexOf("</ScrollView>", scrollAt))
  assert.match(scrollBlock, /q\.options\.map/, "ScrollView must own the options list")
  assert.doesNotMatch(scrollBlock, /\{q\.question\}/, "question text must not be inside the ScrollView")
})

test("prompt cards carry no outer margin (insets belong to the overlay)", () => {
  for (const file of ["components/chat/question-prompt/index.tsx", "components/chat/permission-prompt/index.tsx"]) {
    const src = readKitSource(file)
    const cardBlock = src.match(/card:\s*\{[^}]*\}/s)?.[0]
    assert.ok(cardBlock, `${file}: card style block must exist`)
    assert.doesNotMatch(cardBlock, /margin:\s*12/, `${file}: card must not add margin:12 on top of the overlay padding`)
  }
})

test("permission patterns scroll inside the card instead of growing it", () => {
  const src = readKitSource("components/chat/permission-prompt/index.tsx")
  assert.match(src, /testID="permission-patterns-scroll"/, "patterns ScrollView needs a Maestro testID")
  assert.match(src, /<ScrollView/, "long pattern lists must scroll inside the card")
})
