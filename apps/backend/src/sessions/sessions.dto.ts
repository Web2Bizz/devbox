/**
 * Sessions DTO — single source of truth is @rush-code/contracts (domain
 * SessionInfo / CreateSessionRequest shapes + boundary schemas), same
 * re-export pattern as projects/dto.ts.
 */
export {
  createSessionRequestSchema,
  type CreateSessionInput,
  type SessionInfo,
  type SessionInfoList,
  type SessionInfoModel,
  type SessionRunStatus,
  type SessionRunStatusMap,
} from '@rush-code/contracts';
