// GitHub App authentication without a dependency: an RS256 App JWT signed with the Secrets Store key, traded
// for an installation token scoped to one repository id with exactly the two permissions promotion needs:
// contents (refs, commits, merges, tags) and pull requests (read the PR, comment, close).
// Tokens are cached per repository until five minutes before they expire. Nothing here logs.

import { callGitHub, describeStatus } from './github-api.ts';
import type { Fetcher, HttpLimits } from './http.ts';
import { HTTP_LIMITS } from './http.ts';
import { isPlainObject, isPositiveInteger } from './json.ts';
import { signRs256 } from './jwt.ts';
import { refuse } from './refusal.ts';

export interface AppIdentity {
  readonly appId: string;
  readonly installationId: string;
}

/** GitHub accepts an App JWT for at most 10 minutes; one minute of backdating absorbs clock skew. */
export const APP_JWT = Object.freeze({ backdateSeconds: 60, lifetimeSeconds: 540 });

export const INSTALLATION_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write' });

export const TOKEN_REFRESH_BEFORE_MS = 5 * 60_000;

export const TOKEN_LIMITS = Object.freeze({ maxTokenLength: 512 });

export interface InstallationToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export function appJwtClaims(appId: string, nowSeconds: number): { readonly iat: number; readonly exp: number; readonly iss: string } {
  return { iat: nowSeconds - APP_JWT.backdateSeconds, exp: nowSeconds + APP_JWT.lifetimeSeconds, iss: appId };
}

export function mintAppJwt(key: CryptoKey, appId: string, nowMs: number): Promise<string> {
  return signRs256(key, appJwtClaims(appId, Math.floor(nowMs / 1000)));
}

export function installationTokenPath(installationId: string): string {
  return `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
}

function readInstallationToken(body: unknown, repoId: number): InstallationToken {
  if (!isPlainObject(body)) refuse('api_error', 'installation_token: shape');
  const token = body['token'];
  if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_LIMITS.maxTokenLength) refuse('api_error', 'installation_token: token');
  const expiresAt = typeof body['expires_at'] === 'string' ? Date.parse(body['expires_at']) : Number.NaN;
  if (!Number.isFinite(expiresAt)) refuse('api_error', 'installation_token: expires_at');
  const permissions = body['permissions'];
  if (!isPlainObject(permissions) || permissions['contents'] !== 'write' || permissions['pull_requests'] !== 'write') {
    refuse('bad_config', 'app_permissions');
  }
  const repositories = body['repositories'];
  if (!Array.isArray(repositories) || repositories.length !== 1) refuse('repo_mismatch', 'installation_scope');
  const only: unknown = repositories[0];
  if (!isPlainObject(only) || only['id'] !== repoId) refuse('repo_mismatch', 'installation_scope');
  return { token, expiresAt };
}

export interface MintOptions {
  readonly fetcher: Fetcher;
  readonly key: CryptoKey;
  readonly identity: AppIdentity;
  readonly repoId: number;
  readonly nowMs: number;
  readonly limits?: HttpLimits;
}

/** POST /app/installations/{id}/access_tokens scoped to one repository id. */
export async function mintInstallationToken(options: MintOptions): Promise<InstallationToken> {
  const jwt = await mintAppJwt(options.key, options.identity.appId, options.nowMs);
  const response = await callGitHub(
    options.fetcher,
    {
      method: 'POST',
      path: installationTokenPath(options.identity.installationId),
      bearer: jwt,
      body: { permissions: INSTALLATION_PERMISSIONS, repository_ids: [options.repoId] },
    },
    options.limits ?? HTTP_LIMITS,
  );
  if (response.status !== 201) refuse('api_error', describeStatus('installation_token', response.status, response.body));
  return readInstallationToken(response.body, options.repoId);
}

export class InstallationTokenCache {
  readonly #entries = new Map<number, InstallationToken>();
  readonly #refreshBeforeMs: number;
  constructor(refreshBeforeMs: number = TOKEN_REFRESH_BEFORE_MS) {
    this.#refreshBeforeMs = refreshBeforeMs;
  }
  get(repoId: number, nowMs: number): string | undefined {
    const entry = this.#entries.get(repoId);
    if (entry === undefined) return undefined;
    if (nowMs + this.#refreshBeforeMs >= entry.expiresAt) {
      this.#entries.delete(repoId);
      return undefined;
    }
    return entry.token;
  }
  put(repoId: number, token: InstallationToken): void {
    this.#entries.set(repoId, token);
  }
  get size(): number {
    return this.#entries.size;
  }
}

export interface TokenSourceOptions {
  readonly fetcher: Fetcher;
  readonly key: () => Promise<CryptoKey>;
  readonly identity: AppIdentity;
  readonly clock: () => number;
  readonly cache: InstallationTokenCache;
  /** Called with every secret value produced here so the logger can scrub it. */
  readonly register?: (value: string) => void;
  readonly limits?: HttpLimits;
}

export type InstallationTokenSource = (repoId: number) => Promise<string>;

/** A per-repository token getter: cache hit, or one mint shared by concurrent callers. */
export function createInstallationTokenSource(options: TokenSourceOptions): InstallationTokenSource {
  const inflight = new Map<number, Promise<InstallationToken>>();
  return async (repoId) => {
    if (!isPositiveInteger(repoId)) refuse('bad_repo_id');
    const cached = options.cache.get(repoId, options.clock());
    if (cached !== undefined) return cached;
    let pending = inflight.get(repoId);
    if (pending === undefined) {
      pending = (async () => {
        const key = await options.key();
        const minted = await mintInstallationToken({
          fetcher: options.fetcher,
          key,
          identity: options.identity,
          repoId,
          nowMs: options.clock(),
          ...(options.limits === undefined ? {} : { limits: options.limits }),
        });
        options.register?.(minted.token);
        options.cache.put(repoId, minted);
        return minted;
      })();
      inflight.set(repoId, pending);
      pending.finally(() => inflight.delete(repoId)).catch(() => undefined);
    }
    return (await pending).token;
  };
}
