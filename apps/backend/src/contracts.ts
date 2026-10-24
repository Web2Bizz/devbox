/**
 * @deprecated Import from '@rush-code/contracts' instead — this module is a
 * thin Forward-Only re-export kept for one release so existing imports keep
 * compiling. It carries types only (no runtime schemas); the single source
 * of truth for entities + zod boundary schemas is
 * packages/contracts (mirrors contracts/openapi.yaml field-for-field).
 * Will be removed in the next release — do not add new exports here.
 */
export type {
  ApiError,
  AuthSession,
  AuthTokens,
  AuthUser,
  ChatMessage,
  ChatRole,
  HealthResponse,
  MessagesResponse,
  NpmRegistryStatusResponse,
  OpencodeKeyDeleteResult,
  OpencodeKeyResult,
  OpencodeKeyStatus,
  OpencodeLimitBucket,
  OpencodeUsage,
  RegistryCatalogResponse,
  RepoEntry,
  SendChatRequest,
  SendChatResponse,
  Session,
} from '@rush-code/contracts';
