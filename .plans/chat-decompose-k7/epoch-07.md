# Epoch 7: Final controls, acceptance, risks

## Hypothesis
Готовность = все контроли зелёные + визуал 1:1 + `chat-window.tsx` не существует.

## Evidence Found
- Канонные проверки фронта: `bun run lint` (`tsc --noEmit` + `biome lint`) + `bun run build` (`next build --turbopack`) (AGENTS.md). Плюс §1/§2/§3-контроли из Epoch 5 и жёсткие требования сетки из задачи.

## Decisions
- Decision D15 (финальный прогон, дословно из корня репо):
  ```sh
  find apps/frontend/src/features -mindepth 2 -print
  # ожидаемо: только apps/frontend/src/features/usage/* (долг вне скоупа); chat/* — пусто
  for d in apps/frontend/src/components/chat/*/; do ls "$d" | grep -q '\.tsx$' && { test -f "$d/types.ts" || echo "NO types.ts: $d"; test -f "$d/index.ts" || echo "NO index.ts: $d"; }; done
  grep -rln 'export type \w\+Props' apps/frontend/src/components --include='*.tsx' --include='!types.ts'; echo "props-outside-types: $?"
  grep -rn "^'use client'" apps/frontend/app --include='layout.tsx'; echo "client-in-layout: $?"
  grep -rn 'h-\[calc(100dvh' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'; echo "dvh-outside-layout: $?"
  grep -rn 'absolute.*bottom-2\|right-\[calc' apps/frontend/src/features apps/frontend/src/components --include='*.tsx'; echo "pin-outside-layout: $?"
  ls apps/frontend/src/components/chat/chat-window 2>&1; echo "(must be: No such file)"
  grep -rn 'ChatWindow' apps/frontend/src apps/frontend/app --include='*.tsx' --include='*.ts'; echo "(must be empty)"
  bun run lint
  bun run build
  ```
- Decision D16 (приёмка визуала, вручную 1 раз): открыть `…/sessions/[id]`: ① сообщения стартуют ниже Header (pt underlap), при скролле уходят ЗА Header (полупрозрачный бар выше, Header z-30); ② PromptInput закреплён внизу, `z-20` выше треда, ниже Header; ③ скролл только внутри Content (body не скроллится); ④ empty/loading/error выглядят как раньше; ⑤ thinking→streaming переход без прыжка; ⑥ timeline раскрывается внутри треда, не уводит auto-follow; ⑦ fork/revert диалоги открываются из рядов.
- Decision D17 (риски): R1 — `right-[calc((100%-300px)*0.25)]` убран в пользу `sticky+mx-auto`: на узких экранах 50% композера может сузиться — митигация: ширину вынести в layout-константу, проверить 768/1280/1920. R2 — переименование `chat-tools-timeline→chat-tool-timeline` ломает импорты тестов — митигация: `grep -r tools-timeline` после шага 1. R3 — DESIGN-права требует human approve (DESIGN §6 владелец-человек) — митигация: PR с пометкой «реестр §3» отдельно от кода. R4 — `usage/` останется нарушением `find -mindepth` — митигация: зафиксировать в PLAN как out-of-scope, контроль фильтровать `grep -v usage`.

## Confirmed Plan Items
1. Финальные команды — решение D15, артефакт: вывод выше, валидация: всё пусто/зелёно кроме usage-долга.
2. Ручная приёмка 7 пунктов — решение D16.
3. Риски R1–R4 + митигации — решение D17.

## Open Questions
- Нет открытых вопросов; план готов к синтезу в PLAN.md.

## Next Epoch Focus
- Синтез: PLAN.md + evolution-log.md.
