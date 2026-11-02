import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '../../../../../common/env/env';

const FALLBACK_URL = 'http://localhost:4096';
const FALLBACK_TIMEOUT_MS = 10000;

/**
 * OpencodeConfig — single owner of the OPENCODE_* dial config, shared by
 * OpencodeService (upstream fetch + liveness probe) and OpencodeSdkClient
 * (sdk baseUrl + transport timeout).
 *
 * It is a separate provider precisely so the sdk client never has to import
 * OpencodeService for `dialUrl()`/`timeoutMs` — that value import closed an
 * `OpencodeService ↔ OpencodeSdkClient` cycle (TDZ at boot).
 *
 * - `baseUrl` is the canonical opencode URL, no trailing slash; an explicit
 *   0.0.0.0 host is preserved verbatim (the stand listens on all interfaces;
 *   env assembly never rewrites it).
 * - `dialUrl()` remaps undialable 0.0.0.0 / :: → 127.0.0.1 for outbound
 *   requests only; localhost configs pass through untouched.
 * - `timeoutMs` is the REQUEST_TIMEOUT_MS budget.
 *
 * Values are resolved per call (never cached): `validateEnv(process.env)` is
 * the single strict source and the process env may be re-pointed at runtime
 * (e2e swaps OPENCODE_URL between phases).
 */
@Injectable()
export class OpencodeConfig {
  constructor(@Optional() private readonly config?: ConfigService) {}

  private resolved(): { url: string; timeoutMs: number } {
    try {
      const env = validateEnv(process.env);
      return { url: env.opencodeUrl, timeoutMs: env.requestTimeoutMs };
    } catch {
      // readonly-исключение: fail-open к сырым ConfigService-значениям только
      // для чтения конфига (trimmed, never logged); явный OPENCODE_URL имеет
      // приоритет, dev-дефолт FALLBACK_URL — лишь когда ничего не задано.
      // Валидационные ERROR validateEnv (bad PORT/URL/...) при этом не маскируются
      // под успех — boot всё равно падает в ConfigModule.validate, а запросы к
      // незаданному апстриму отвечают 503 (never 200 mock).
      const url = this.config?.get<string>('OPENCODE_URL')?.trim() || FALLBACK_URL;
      const timeoutRaw = Number(this.config?.get<string>('REQUEST_TIMEOUT_MS'));
      const timeoutMs =
        Number.isInteger(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : FALLBACK_TIMEOUT_MS;
      return { url: url.replace(/\/+$/, ''), timeoutMs };
    }
  }

  /** Canonical opencode URL, no trailing slash, explicit 0.0.0.0 preserved. */
  get baseUrl(): string {
    return this.resolved().url;
  }

  get timeoutMs(): number {
    return this.resolved().timeoutMs;
  }

  /**
   * Dialable base URL: 0.0.0.0 / :: mean "all interfaces" and are not
   * dialable on every platform — probe 127.0.0.1 instead. The configured
   * `baseUrl` keeps 0.0.0.0 verbatim; only outbound dialing is remapped.
   */
  dialUrl(): string {
    try {
      const parsed = new URL(this.baseUrl);
      if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') {
        parsed.hostname = '127.0.0.1';
      }
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return this.baseUrl;
    }
  }
}
