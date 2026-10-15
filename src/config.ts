// Non-secret configuration from Wrangler vars, validated once per call. Refusals name the variable, never a value.

import type { AppIdentity } from './github-app.ts';
import { isPlainObject } from './json.ts';
import { refuse } from './refusal.ts';

/** The Secrets Store binding: the only thing in `env` that is a secret, read lazily and never logged. */
export interface SecretReader {
  get(): Promise<string>;
}

export interface Env {
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_INSTALLATION_ID: string;
  readonly GH_OWNER: string;
  readonly GH_OWNER_ID: string;
  readonly GITHUB_APP_KEY: SecretReader;
}

export interface Config {
  readonly identity: AppIdentity;
  readonly owner: string;
  readonly ownerId: number;
}

const NUMERIC_ID = /^[1-9][0-9]{0,15}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function numericVar(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || !NUMERIC_ID.test(value)) refuse('bad_config', name);
  return value;
}

export function readConfig(env: unknown): Config {
  if (!isPlainObject(env)) refuse('bad_config', 'env');
  const appId = numericVar(env, 'GITHUB_APP_ID');
  const installationId = numericVar(env, 'GITHUB_APP_INSTALLATION_ID');
  const ownerId = Number(numericVar(env, 'GH_OWNER_ID'));
  const owner = env['GH_OWNER'];
  if (typeof owner !== 'string' || !LOGIN.test(owner)) refuse('bad_config', 'GH_OWNER');
  const key = env['GITHUB_APP_KEY'];
  if (typeof key !== 'object' || key === null || typeof (key as { get?: unknown }).get !== 'function') refuse('bad_config', 'GITHUB_APP_KEY');
  return Object.freeze({ identity: Object.freeze({ appId, installationId }), owner, ownerId });
}

export function secretReader(env: unknown): SecretReader {
  readConfig(env);
  return (env as Env).GITHUB_APP_KEY;
}
