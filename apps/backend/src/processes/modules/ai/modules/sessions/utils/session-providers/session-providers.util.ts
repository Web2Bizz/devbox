import { ExternalServiceError } from '@common/external/external-error';
import type { SessionModel, SessionRunnerProvider } from '../../sessions.dto';
import type { ProviderActivation, UpstreamProviderInfo } from '../../sessions.types';

/**
 * Activation gate as a real type predicate (plain boolean variables do
 * not narrow union members under strictNullChecks).
 */
export function isProviderActivation(value: unknown): value is ProviderActivation {
  return value === 'auto' || value === 'enabled' || value === 'disabled';
}

/**
 * Project the artifact Provider.Info rows to the REQUIRED domain subset
 * (id/name/activation/package). settings/headers/body are never projected;
 * a row violating the required set fails loud with EXTERNAL_UNAVAILABLE.
 */
export function projectProviders(data: unknown): Array<SessionRunnerProvider> {
  if (!Array.isArray(data)) {
    throw new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'opencode',
      operation: 'sessionProviders',
      message: 'сервис временно недоступен, повторите позже',
      isRetryable: false,
      cause: new Error('bad_shape'),
    });
  }
  return (data as unknown as Array<UpstreamProviderInfo>).map(
    (provider): SessionRunnerProvider => {
      if (
        typeof provider.id !== 'string' ||
        provider.id.length === 0 ||
        typeof provider.name !== 'string' ||
        typeof provider.package !== 'string' ||
        !isProviderActivation(provider.activation)
      ) {
        throw new ExternalServiceError({
          code: 'EXTERNAL_UNAVAILABLE',
          service: 'opencode',
          operation: 'sessionProviders',
          message: 'сервис временно недоступен, повторите позже',
          isRetryable: false,
          cause: new Error('bad_shape'),
        });
      }
      return {
        id: provider.id,
        name: provider.name,
        activation: provider.activation,
        package: provider.package,
      };
    },
  );
}

/**
 * Host model inventory filtered to the OpenCode Go/Zen family (provider id
 * opencode / opencode-go / opencode-zen). Foreign providers are skipped;
 * a family row without a model id fails loud with EXTERNAL_UNAVAILABLE.
 */
export function projectModels(data: unknown): Array<SessionModel> {
  if (!Array.isArray(data)) {
    throw new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'opencode',
      operation: 'sessionModels',
      message: 'сервис временно недоступен, повторите позже',
      isRetryable: false,
      cause: new Error('bad_shape'),
    });
  }
  const output: Array<SessionModel> = [];
  for (const rawValue of data as unknown as Array<Record<string, unknown>>) {
    const providerID: string =
      typeof rawValue.providerID === 'string' ? rawValue.providerID : '';
    if (!['opencode', 'opencode-go', 'opencode-zen'].includes(providerID)) continue;
    const modelID: string =
      typeof rawValue.modelID === 'string'
        ? rawValue.modelID
        : typeof rawValue.id === 'string'
          ? rawValue.id
          : '';
    const name: string = typeof rawValue.name === 'string' ? rawValue.name : modelID;
    if (!modelID) {
      throw new ExternalServiceError({
        code: 'EXTERNAL_UNAVAILABLE',
        service: 'opencode',
        operation: 'sessionModels',
        message: 'сервис временно недоступен, повторите позже',
        isRetryable: false,
        cause: new Error('bad_shape'),
      });
    }
    output.push({ id: modelID, name, providerID });
  }
  return output;
}
