# План: привести users-домен в порядок без изменения поведения

## Контекст

Привести users-домен в порядок без изменения поведения: вынести `PasswordService` в `users/modules/password/`, выделить типы/репозиторий/DTO, унифицировать контроллер, покрыть тестами.

## Шаг 1. Вынести `PasswordService` в `users/modules/password/`

Что сделать:

- Создать `apps/backend/src/users/modules/password/` + `__tests__/` внутри.
- `git mv apps/backend/src/users/password.service.ts apps/backend/src/users/modules/password/password.service.ts` без правок.
- Создать `password.module.ts` с `PasswordModule` (providers/export: PasswordService).
- В `users.module.ts`: `imports: [PasswordModule]`, убрать прямой `PasswordService` из `providers/exports`, `exports: [UsersService, PasswordModule]`.
- Обновить импорты в `users.service.ts` и `auth/auth-provider.ts` на новый путь. `auth.module.ts` и `app.module.ts` не трогать.
- Переименовать `passwords` → `passwordService` в `users.service.ts` и `auth-provider.ts`.

Критерии приёмки:

- `ls users/modules/password/` = `password.module.ts password.service.ts __tests__/`.
- `tsc --noEmit` зелёный, `bun run lint` зелёный.
- `bun run build` зелёный + `bun run test:e2e:auth` зелёный (поведение не изменилось).

## Шаг 2. Зафиксировать решения по scope

Что сделать:

- Подтвердить граф импортов `UsersModule` в `app.module.ts`, `auth.module.ts`, `organizations.module.ts`.
- Зафиксировать: оставить `@Global()` или развести явные импорты.
- Зафиксировать эталон извлечения `correlationId` по `auth.controller.ts`.
- Выбрать место `isUserId/isUniqueViolation`: приват репозитория или `users/utils/<name>/`.

Критерии приёмки:

- Решение по `@Global()` записано.
- Эталон `correlationId` зафиксирован.
- Место хелперов выбрано.

## Шаг 3. Выделить `users.types.ts`

Что сделать:

- Создать `users.types.ts`: `AuthProviderId`, `StoredUser`, `PublicUser`, `CreateLocalInput`, `UpdateProfilePatch`, `RequestCorrelation` (все `export type`, `createdAt/updatedAt: string` с `/** ISO-8601 timestamp */`).
- В `users.service.ts`: импортировать типы, удалить локальные; `toPublicUser(user: StoredUser): PublicUser`; `isUniqueViolation(error)`, все `catch (error)`.
- В `modules/password/password.service.ts`: `catch (error)`, `runtime/passwordApi`, фиксированное сообщение verify + detail в debug без секретов.

Критерии приёмки:

- `tsc --noEmit` зелёный, `bun run lint` зелёный.
- `bun run build` зелёный.

## Шаг 4. Выделить `users.repository.ts` + `users.dto.ts`

Что сделать:

- Создать `users.repository.ts` (`UsersRepository`): все drizzle-запросы, маппер `UserRow→StoredUser`, 409-детект внутри; сервис drizzle не импортирует.
- Создать `users.dto.ts` (реэкспорт zod + swagger `UserDto` с `createdAt format: date-time`); убрать каст `as AuthUserDto`.
- Переименовать `db→databaseService`, `users→usersService`.

Критерии приёмки:

- В `users.service.ts` нет `drizzle-orm`/`schema` импортов.
- Нет `as AuthUserDto` в users-домене.
- `tsc --noEmit` зелёный, `bun run lint` зелёный, `bun run build` зелёный.

## Шаг 5. Контроллер

Что сделать:

- `users.controller.ts`: `req` → `request: RequestCorrelation`, тип из `users.types.ts`.
- Привести извлечение `correlationId` к эталону из шага 2, поведение не менять.
- Привести кавычки к конфигу biome по `users/` рекурсивно.

Критерии приёмки:

- `tsc --noEmit` зелёный, `bun run lint` зелёный.
- `bun run build` зелёный.

## Шаг 6. Тесты

Что сделать:

- Создать `users/modules/password/__tests__/password.spec.ts` (hash/verify, verify-false, driver-failure → false без секретов).
- Создать `users/__tests__/users.spec.ts` (createLocal 409-null, findByEmail case-insensitive, findById non-uuid → null, updateProfile).
- Если хелперы в `utils/<name>/` — у каждой своя `__tests__/<name>.spec.ts`, импорт только через `index.ts`.
- Чужие сьюты оставить как интеграционные.

Критерии приёмки:

- `bun run test` зелёный (юниты).
- `bun run test:e2e:auth` зелёный.

## Решения (шаг 2)

- **@Global()**: `UsersModule` остаётся `@Global()` — поведение не меняем.
  `UsersService` инжектится в `organizations/` (`organizations.service.ts`,
  `members.service.ts`, `invites.service.ts`), `auth/` (`jwt-auth.guard.ts`,
  `auth.controller.ts`) и `processes/` без явных импортов. `PasswordModule` —
  вложенный (`users/modules/password/`), наружу домена не торчит;
  `UsersModule` реэкспортирует его, поэтому `LocalAuthProvider` продолжает
  получать `PasswordService` по цепочке `AuthModule → UsersModule`.
- **Эталон `correlationId`**: `auth/auth.controller.ts` —
  `@Req() request?: RequestCorrelation` + `const correlationId = request?.correlationId;`
  (опциональное поле, без `any` и без `(req as { … })`-кастов).
  `users.controller.ts` приводится к этому же виду (шаг 5).
- **Место `isUserId`/`isUniqueViolation`**: приватные функции
  `users/users.repository.ts` (не `utils/<name>/`). Обе — деталь доступа к
  данным: uuid-guard перед SQL и SQLSTATE 23505 после insert; снаружи домена
  они не нужны, публичная директория утилиты раскрывала бы внутреннюю деталь
  ради тестов. Тесты домена (`users/__tests__/users.spec.ts`) ходят через
  реальный `UsersService` + `UsersRepository` со стабом `DbService`.
- **Граф импортов (подтверждён)**: `app/app.module.ts` → `imports: [UsersModule]`
  (единственная регистрация в `AppModule`); `auth/auth.module.ts` →
  `imports: [UsersModule]` (нужен `LocalAuthProvider`/`JwtAuthGuard`);
  `organizations/organizations.module.ts` `UsersModule` не импортирует —
  `UsersService` приходит из глобального модуля (`organizations.service.ts`,
  `modules/members/members.service.ts`, `modules/invites/invites.service.ts`).
  Обратного импорта `UsersModule → AuthModule` нет — граф остаётся ацикличным.
