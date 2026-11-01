# AGENTS.md — biome-config (общий Biome-конфиг)

Этот файл — канон пакета: назначение, структура, правила изменения.
Корень [`AGENTS.md`](../../AGENTS.md) хранит только ссылку сюда.

---

**Описание**: Единый Biome-конфиг для bun workspaces (backend/frontend/cli/contracts).
**Ключевые слова**: biome, lint, shared-config, no-console

---

## `@rush-code/biome-config`

Пакет хранит общий `biome.json` — единственный источник настроек линта:
парсер (`unsafeParameterDecoratorsEnabled` для NestJS-декораторов),
правило `suspicious/noConsole: error` и исключения для тестовых репортеров
(`*.spec/e2e/test`, `__tests__`) и CLI-утилиты `schema-integrity.ts`.
Рантайм-логики нет — только конфиг.

## Структура

```
biome.json   — общий конфиг (extends-точка для корня и сервисов)
package.json — приватный workspace-пакет (exports: ./biome.json)
project.json — nx-обёртка без таргетов (линт идёт через потребителей)
```

## Правила

- Править только `biome.json` — корень (`biome.jsonc`) и per-app/per-package
  `biome.jsonc` лишь наследуют его через `extends` + локальные игноры сборки
  (`dist/`, `.next/`, `node_modules/`, `coverage/`).
- Все вложенные конфиги обязаны иметь `"root": false` — иначе Biome падает
  «nested root configuration».
- Override-глобы резолвятся от каталога наследующего конфига: пути вида
  `apps/frontend/...` живут только в корне или в per-app конфиге, но не в общем.
- Исключение `app/error.tsx` (Next.js error boundary) живёт в
  `apps/frontend/biome.jsonc` — файлы под `apps/frontend/` управляются
  ближайшим конфигом, корневой override их не видит.
- `preset: "none"` осознанно: включён только `noConsole`. Расширение набора
  правил — отдельным изменением.
- Форматтер (`biome format`) не подключён — отдельное изменение.
- ESLint нет: `eslint-disable`-комментарии мертвы — удалять, не конвертировать
  в `biome-ignore` (неиспользуемая супрессия даёт `suppressions/unused` warning).
- Nx: пакет добавлен в root `workspaces` + `sharedGlobals` (`biome.jsonc`,
  `packages/biome-config/biome.json`) — смена конфига инвалидирует lint-кэш.

## Скрипты

- Отдельных скриптов нет. Проверка: `bunx biome lint .` из корня (417 файлов)
  или `biome lint .` с cwd сервиса (per-app конфиг).
