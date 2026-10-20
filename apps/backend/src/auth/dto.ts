/**
 * Auth DTO — single source of truth is @devbox/contracts (verbatim trims,
 * min/max, email regex + error strings; trim-first semantics preserved).
 * Controllers keep importing from './dto' — the runtime objects are
 * the package schemas. Swagger body DTOs live in ./auth.dto.ts.
 */
export {
  loginSchema,
  refreshSchema,
  registerSchema,
  updateMeSchema,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
  type UpdateMeInput,
} from '@devbox/contracts';
