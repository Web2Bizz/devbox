/**
 * Runs DTO — single source of truth is @rush-code/contracts (domain
 * RunInfo / CreateRunRequest shapes + boundary schemas), same re-export
 * pattern as sessions.dto.ts and projects/dto.ts.
 */
export {
  createRunRequestSchema,
  runInfoListSchema,
  runInfoSchema,
  runStreamFrameSchema,
  toolViewSchema,
  type CreateRunInput,
  type RunInfo,
  type RunInfoList,
  type RunStatus,
  type RunStepStatus,
  type RunStepType,
  type RunStreamFrame,
  type ToolView,
} from '@rush-code/contracts';
