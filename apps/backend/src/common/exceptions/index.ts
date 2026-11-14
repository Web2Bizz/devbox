/**
 * exceptions barrel — единая точка импорта глобального слоя ошибок.
 * common/exceptions не импортирует фиче-модули (стрелка только вниз).
 */
export * from "./app-error";
export * from "./storage-unavailable.error";
export * from "./validation.error";
export * from "./process-error";
