/**
 * @deprecated Import from '@devbox/contracts' instead — this module is a
 * thin Forward-Only re-export kept for one release so existing imports keep
 * compiling. It carries types only (no runtime schemas); the single source
 * of truth for entities + zod v4 boundary schemas is packages/contracts
 * (mirrors contracts/openapi.yaml field-for-field).
 * Will be removed in the next release — do not add new exports here.
 *
 * Parity notes (frontend-additive preserved):
 * - `ProjectApiDto` = package `Project` (includes optional `scope`:
 *   'user' | 'org' — old caches without it stay valid).
 * - `OrganizationDto` = package `Organization`,
 *   `MemberDto` = `OrganizationMember`, `InviteDto` = `OrganizationInvite`.
 * - `*Request` aliases = package `*Input` (inferred from the
 *   backend-verbatim zod schemas, same shapes as the old local DTOs).
 */

export type {
  AcceptInviteInput,
  AddMemberInput,
  ApiError,
  AuthSession,
  AuthTokens,
  AuthUser,
  ChatMessage,
  ChatRole,
  CreateInviteInput,
  CreateOrganizationInput,
  CreateProjectInput,
  HealthResponse,
  LoginInput,
  MessagesResponse,
  NpmRegistryStatusResponse,
  OpencodeKeyDeleteResult,
  OpencodeKeyInput,
  OpencodeKeyResult,
  OpencodeKeyStatus,
  OpencodeLimitBucket,
  OpencodeUsage,
  Organization,
  OrganizationInvite,
  OrganizationMember,
  OrgRole,
  Project,
  ProjectScope,
  RefreshInput,
  RegisterInput,
  RegistryCatalogResponse,
  RepoEntry,
  SendChatRequest,
  SendChatResponse,
  Session,
  UpdateMeInput,
  UpdateMemberRoleInput,
  UpdateOrganizationInput,
  UpdateProjectInput,
} from '@devbox/contracts';

export type {
  Project as ProjectApiDto,
  CreateProjectInput as CreateProjectRequest,
  Organization as OrganizationDto,
  CreateOrganizationInput as CreateOrganizationRequest,
  UpdateOrganizationInput as UpdateOrganizationRequest,
  OrganizationMember as MemberDto,
  AddMemberInput as AddMemberRequest,
  UpdateMemberRoleInput as UpdateMemberRoleRequest,
  OrganizationInvite as InviteDto,
  CreateInviteInput as CreateInviteRequest,
  AcceptInviteInput as AcceptInviteRequest,
} from '@devbox/contracts';
