# AGENTS.md — DevBox Backend (monorepo)

Монорепо: `apps/backend` (NestJS API), `apps/frontend` (Next.js 16.3
Turbopack + `@web2bizz/ui` 0.25.9), `contracts/openapi.yaml`.

## Frontend — дизайн-система

- Договорённости по layout/токенам/радиусам/бренду:
  [`apps/frontend/DESIGN.md`](apps/frontend/DESIGN.md) — читать перед
  правками шелла (`dashboard-shell`, `layout/Sidebar`, `layout/Content`,
  `app/globals.css`).
- Порядок стилей: `@web2bizz/ui/styles.css` → `globals.css`
  (source order, не менять). Hex — только `:root` / `.dark`.
- Проверки после правок фронта: `bun --filter frontend lint`
  (`tsc --noEmit`) + `bun --filter frontend build` (`next build --turbopack`).

## Фолбэки запрещены по умолчанию

- Никаких тихих фолбэков (дефолтные пути вроде `<cwd>/...`, захардкоженные хосты/порты, подмена отсутствующего значения «удобным») без явного указания пользователя. Не задано → ошибка, а не додумывание.
- Особенно строго: валидация конфигов и env-переменных (`env.ts`, `.env.example`, `resolveRoot`-подобные резолверы). Отсутствующая обязательная переменная для записи/мутации → fail-fast с понятной ошибкой (что задать, где), а не fallback-путь и не WARN-тихоня. Фолбэк для чтения/readonly допустим лишь как исключение для тюнинга (таймауты/ретраи/хосты dev-dial) и фиксируется комментарием — но НЕ для путей хранения.
- Единый каталог: `REPOS_ROOT` — единственный источник чтения И записи всего storage (repos list, workspaces tree/submodules, project-files tree, clone dest, projects create/remove). Без конфига — отказ: storage-чтения отвечают 503 `EXTERNAL_UNAVAILABLE` (Retry-After 30, с correlationId), создание проектов — 500 до INSERT; boot без корня продолжается, но лог на уровне ERROR честно сообщает о недоступности (health без изменений). Исключения: `GET /projects` и `GET /projects/:id` без корня — как сейчас (`corrupted` + `storage-unconfigured`). Никогда не читать/создавать `<cwd>/repos`, не отдавать молча `[]`/404 по нему.
- Прецедент: тихий fallback `REPOS_ROOT` → `<PROJECTS_ROOT>/repos` → `<cwd>/repos` молча создавал проекты не там (см. strict-резолвер projects) — так больше не делать; цепочка удалена полностью, включая READ-пути.
