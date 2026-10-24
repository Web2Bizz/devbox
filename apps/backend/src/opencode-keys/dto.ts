/**
 * PUT /api/v1/key — single source of truth is @rush-code/contracts
 * (verbatim trim/min/max + error strings: short strings are almost
 * certainly a paste mistake, so min 20 fails fast). Controllers keep
 * importing from './dto' — the runtime object is the package schema.
 * Swagger DTOs live in ./opencode-keys.dto.ts.
 */
export { opencodeKeySchema, type OpencodeKeyInput } from '@rush-code/contracts';
