/**
 * Client auth schemas — re-exported from '@rush-code/contracts' (single source).
 *
 * Package `loginSchema`/`registerSchema` are backend-verbatim
 * (trim-first email regex, name trim/min/max, password min/max) so
 * client pre-submit checks match server 400s; `parseRegisterFieldErrors`
 * stays as the server-fallback mapper. zod v4 + @hookform/resolvers 5.9.1
 * share the same zod 4.6.5 instance, so `zodResolver(loginSchema)` keeps
 * working with no thin wrapper.
 *
 * @deprecated Import from '@rush-code/contracts' directly in new code —
 * this module is a Forward-Only alias kept so `@/lib/auth-schemas`
 * imports keep compiling.
 */

export { loginSchema, registerSchema } from '@rush-code/contracts';
export type { LoginInput, RegisterInput } from '@rush-code/contracts';
