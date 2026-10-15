// Wiring, kept out of the entrypoint so it can be exercised under node: the key source with its own cache,
// the installation token source, the logger and the clock. Nothing here touches a global.

import { readConfig, type Config, type SecretReader } from './config.ts';
import { createInstallationTokenSource, InstallationTokenCache, type InstallationTokenSource } from './github-app.ts';
import type { Fetcher, HttpLimits } from './http.ts';
import { createLogger, type Logger } from './log.ts';
import { importPkcs8Pem, KeyError } from './pkcs8.ts';
import { refuse } from './refusal.ts';

/** The imported key is kept this long before Secrets Store is read again, so a rotated key is picked up without a redeploy. */
export const KEY_CACHE_TTL_MS = 10 * 60_000;

export interface CommonDeps {
  readonly config: () => Config;
  readonly fetcher: Fetcher;
  readonly token: InstallationTokenSource;
  readonly logger: Logger;
  readonly clock: () => number;
}

export class KeyCache {
  #key: CryptoKey | undefined;
  #readAt = Number.NEGATIVE_INFINITY;
  readonly #ttlMs: number;
  constructor(ttlMs: number = KEY_CACHE_TTL_MS) {
    this.#ttlMs = ttlMs;
  }
  /** Read the PEM through `reader`, import it, cache it; `register` sees the PEM so logs can never carry it. */
  async get(reader: SecretReader, nowMs: number, register: (secret: string) => void, subtle?: SubtleCrypto): Promise<CryptoKey> {
    if (this.#key !== undefined && nowMs - this.#readAt < this.#ttlMs) return this.#key;
    let pem: string;
    try {
      pem = await reader.get();
    } catch {
      return refuse('bad_key', 'unavailable');
    }
    if (typeof pem !== 'string') refuse('bad_key', 'unavailable');
    register(pem);
    try {
      this.#key = await importPkcs8Pem(pem, subtle);
    } catch (error) {
      if (error instanceof KeyError) refuse('bad_key', error.problem);
      throw error;
    }
    this.#readAt = nowMs;
    return this.#key;
  }
}

export interface WiringOptions {
  readonly env: unknown;
  readonly fetcher: Fetcher;
  readonly sink: (line: string) => void;
  readonly tokenCache: InstallationTokenCache;
  readonly keyCache: KeyCache;
  readonly clock?: () => number;
  readonly subtle?: SubtleCrypto;
  readonly limits?: HttpLimits;
}

export function createDeps(options: WiringOptions): CommonDeps {
  const clock = options.clock ?? (() => Date.now());
  const logger = createLogger(options.sink);
  // Configuration is validated lazily so a bad placeholder becomes a refusal from `run`, never a thrown error.
  const config = (): Config => readConfig(options.env);
  const token = createInstallationTokenSource({
    fetcher: options.fetcher,
    key: () => options.keyCache.get((options.env as { GITHUB_APP_KEY: SecretReader }).GITHUB_APP_KEY, clock(), (s) => logger.register(s), options.subtle),
    identity: config().identity,
    clock,
    cache: options.tokenCache,
    register: (s) => logger.register(s),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { config, fetcher: options.fetcher, token, logger, clock };
}
