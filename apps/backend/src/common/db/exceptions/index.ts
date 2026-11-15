/**
 * db/exceptions barrel — единая точка импорта DB-слоя ошибок.
 * common/db/exceptions не импортирует фиче-модули (стрелка только вниз).
 */
export * from "./pg-transient";
export * from "./db-unavailable.error";
