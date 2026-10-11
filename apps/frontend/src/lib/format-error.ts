import { ApiClientError } from '../api/client';

/**
 * Human-readable message for any hook/page error.
 * Keeps the `ApiClientError` branch explicit so real API failures
 * surface `code + correlationId` instead of a generic string.
 */
export function formatApiError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

export interface FormattedApiError {
  code: string;
  message: string;
  correlationId: string;
  /** First 8 chars of the correlationId for compact UI display. */
  shortId: string;
  /** `code: message (ID: shortId)` — additive display, envelope untouched. */
  display: string;
}

/**
 * Full error detail with correlationId for the diagnostic Alert.
 * Additive over formatApiError — never changes the {code,message} text,
 * only appends the traceable short ID. No secrets carried (code/message
 * come from the safe backend envelope; tokens/passwords never logged).
 */
export function formatApiErrorWithId(error: unknown): FormattedApiError {
  if (error instanceof ApiClientError) {
    const shortId = error.correlationId.slice(0, 8);
    return {
      code: error.code,
      message: error.message,
      correlationId: error.correlationId,
      shortId,
      display: `${error.code}: ${error.message} (ID: ${shortId})`,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'unknown',
      message: error.message,
      correlationId: '',
      shortId: '',
      display: error.message,
    };
  }
  return {
    code: 'unknown',
    message: 'Unexpected error',
    correlationId: '',
    shortId: '',
    display: 'Unexpected error',
  };
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}
