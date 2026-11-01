# Code of Conduct — backend structure

## Часть I. Домен

### 1. Доменный модуль

```
<domain>/
├─ <domain>.module.ts — Nest-модуль (один на домен)
├─ <domain>.controller.ts — HTTP-слой (тонкий: guard → gate → service)
├─ <domain>.service.ts — бизнес-логика (единственное место сайд-эффектов)
├─ dto.ts — runtime zod-схемы + swagger-классы (§4)
├─ *.util.ts / *.repository.ts / *.config.ts / *.types.ts — по необходимости
├─ modules/ — вложенные Nest-модули, ТОЛЬКО здесь (§2)
└─ __tests__/ — все тесты (*.spec.ts / *.e2e.ts), ТОЛЬКО здесь
```

- Родительский модуль импортирует вложенные; вложенный никогда
  не регистрируется в `AppModule` напрямую.
- Тесты рядом с кодом запрещены — все `*.spec.ts` / `*.e2e.ts`
  лежат в `<domain>/__tests__/`.
- Вложенные модули в `modules/<sub>/` имеют собственные `__tests__/`
  со своими `*.spec.ts` / `*.e2e.ts` (см. §2).

#### Правильно

```
auth/
├─ auth.module.ts
├─ auth.controller.ts
├─ auth.service.ts
├─ auth.dto.ts
├─ modules/
│  └─ keys/
│     ├─ keys.module.ts
│     └─ __tests__/
└─ __tests__/
   ├─ auth.spec.ts
   └─ auth.e2e.ts
```

#### Не правильно

```
auth/
├─ auth.module.ts
├─ auth.spec.ts
└─ keys/
   └─ keys.module.ts
```

- `auth.spec.ts` рядом с кодом — надо в `__tests__/`.
- `keys/` вне `modules/` — надо в `modules/keys/`.

### 2. Вложенные модули

- Nest-модуль внутри другого домена хранится в `<parent>/modules/<sub>/`
  со своим набором `<sub>.module.ts` / `<sub>.controller.ts` /
  `<sub>.service.ts` / `<sub>.dto.ts` / `__tests__/` — повторяет структуру домена (§1).
- Вложенный модуль не экспортируется во внешние слои — используется
  только внутри родительского домена; наружу торчит только родитель.
- Прямые папки-соседи (`<parent>/<sub>/`) для Nest-модулей запрещены.

#### Правильно
```
api/
├─ api.module.ts
└─ modules/
   └─ proxy/
      ├─ proxy.module.ts
      └─ proxy.service.ts
```

#### Не правильно

```
api/
├─ api.module.ts
└─ proxy/
   ├─ proxy.module.ts
   └─ proxy.service.ts
```

### 3. `common/` — исключение

- `common/` — shared-слой, не домен: один `@Global()` модуль
  (`common.module.ts` для `AppLogger` + `ExternalClient`).
- Подпапки `env/`, `external/`, `logger/`, `validation/` — группы утилит,
  НЕ Nest-модули (`*.module.ts` внутри запрещён). Правило `modules/`
  на них не распространяется.
- Корневые файлы `common/`: только `*.filter.ts`, `*.interceptor.ts`,
  `*.module.ts`, `sse-relay.ts`. Новый кросс-доменный код — в `common/`,
  а не в чужом домене.

## Часть II. Рекомендации к написанию кода

### 4. `<domain|module>.dto.ts` — DTO и swagger-классы

#### 4.1. DTO — валидация форм из zod-схемы

`<domain|module>.dto.ts` — единая точка DTO домена для валидации форм: берётся из zod-схемы — `export { … } from '@rush-code/contracts'`, либо локальные `z.object` для доменов без wire-контракта.

#### 4.2. Swagger-классы — только доки

Swagger-классы (`@ApiProperty`) живут в том же `<domain|module>.dto.ts` (эталон: `auth/auth.dto.ts`, `opencode/modules/keys/opencode-keys.dto.ts`).

#### 4.3. Разделение runtime vs docs

Swagger-классы никогда не используются для валидации — только для `@nestjs/swagger`. Runtime — только zod через `ZodValidationPipe`.

### 5. Именование файлов

| Шаблон | Что это | Правило |
| --- | --- | --- |
| `<domain\|module>.module.ts` | Модуль | Ровно один класс `*Module` на файл. |
| `<domain\|module>.controller.ts` | Контроллер | Классы `*Controller`; второй контроллер домена именуется по сущности (`users.controller.ts`, `org-projects.controller.ts`). |
| `<domain\|module>.dto.ts` | DTO | Валидация форм из zod-схемы (§4.1); swagger-классы только для доков (§4.2). |
| `<domain\|module>.service.ts` | Сервис | Бизнес-логика (`github-link.service.ts`, `workspace-path.service.ts`). |
| `<domain\|module>.repository.ts` | Репозиторий | Доступ к данным (`clone-jobs.repository.ts`). |
| `<domain\|module>.guard.ts` | Гард | Nest-инфраструктура рядом с доменом (`jwt-auth.guard.ts`). |
| `<domain\|module>.decorator.ts` | Декоратор | Nest-инфраструктура рядом с доменом (`req-user.decorator.ts`). |
| `__tests__/*.spec.ts` | Юнит-тест | Все юнит-тесты домена, только здесь. |
| `__tests__/*.e2e.ts` | e2e-тест | Все e2e-тесты домена, только здесь. |
| `index.ts` | Баррель | Только в `common/logger/` и `common/validation/`; в доменах баррелей нет — импорт по прямому пути (`./dto`, `./x.service`). |
