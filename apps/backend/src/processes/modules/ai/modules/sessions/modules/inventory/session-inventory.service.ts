import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import {
  OpencodeHostService,
  type HostModelList,
  type HostProviderList,
} from '../../../opencode/opencode-host.service';
import type { SessionModel, SessionRunnerProvider } from '../../sessions.dto';
import { projectModels, projectProviders } from '../../utils/session-providers';

/**
 * SessionInventoryService — the sessions domain's host inventory zone.
 *
 * Owns the two read-only artifact projections (providers/models). The host
 * call stays here so the domain orchestrator never touches the embedded
 * transport directly; the required subset (Provider.Info id/name/activation/
 * package, Go/Zen model family) is projected by the pure session-providers
 * utilities. A malformed payload fails loud with EXTERNAL_UNAVAILABLE at the
 * projection site — never a silent empty answer.
 */
@Injectable()
export class SessionInventoryService {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly logger: AppLogger = new AppLogger(SessionInventoryService.name),
  ) {}

  /**
   * Provider inventory for the gated directory. Host failures keep their
   * honest mapping (rethrow after one warn/debug line); a row violating the
   * required artifact subset fails loud at the projection site.
   */
  async providers(
    directory: string,
    correlationId: string,
  ): Promise<Array<SessionRunnerProvider>> {
    let response: HostProviderList;
    try {
      response = await this.host.providerList(directory);
    } catch (error) {
      this.logger.warn('[sessions] providers list failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      throw error;
    }
    return projectProviders(response.data);
  }

  /**
   * Host model inventory filtered to the OpenCode Go/Zen family. Host
   * failures rethrow unchanged; a family row without a model id fails loud.
   */
  async models(
    directory: string,
    correlationId: string,
  ): Promise<Array<SessionModel>> {
    let response: HostModelList;
    try {
      response = await this.host.modelList(directory);
    } catch (error) {
      this.logger.warn('[sessions] models list failed', correlationId);
      this.logger.debug((error as Error).message, correlationId);
      throw error;
    }
    const models: Array<SessionModel> = projectModels(response.data);
    this.logger.info('[sessions] models listed', correlationId);
    return models;
  }
}
