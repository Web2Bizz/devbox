# Evolution log — clear-hover-mk1

## Epoch 1: Coarse hypothesis
- Hypothesis: всем кнопкам футера достаточно дописать `hover:bg-transparent focus-visible:bg-transparent` без смены variant/hex.
- Decision: scope = 1 файл, 1 карточка low/low; rejected: отдельный CSS-класс / смена variant.
- Status: carried forward.

## Epoch 2: Evidence gathering
- Evidence: `:52` toggle-класс без focus-visible; `:202` CopyButton — эталон; `:213/:227` fork/revert без прозрачности; комментарий `:44-51` про kit-override; тесты `chat-window.test.tsx` классов не проверяют; ветка `feat/cli-cloud-chat`.
- Decision: эталон = строка CopyButton; toggle правится в 1 месте, fork/revert — 2 инлайн-правки; rejected: общая константа для Button (оверхед для low).
- Status: carried forward.

## Epoch 3: Decision foundation (final)
- Decision: обновить и комментарий над `FEEDBACK_TOGGLE_CLASS` (focus-visible); variant/структуру/логику не менять; конфликтов нет.
- Rejected: оставить комментарий устаревшим; менять variant.
- Status: final — синтезировано в `PLAN.md` (шаги 1–5, валидация, Trello-карточка).

## Superseded
- Нет superseded-решений (эволюция линейная, без конфликтов).
