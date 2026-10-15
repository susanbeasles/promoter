// GitHub REST calls. The credential travels only in the Authorization header; the URL is built from
// validated parts under a fixed origin; the response is bounded and fatally decoded by `fetchJson`.

import { fetchJson, HTTP_LIMITS, HttpError, type Fetcher, type HttpLimits, type JsonResponse } from './http.ts';
import { canonicalJson, isPlainObject, type JsonValue } from './json.ts';
import { refuse } from './refusal.ts';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'promoter (susanbeasles control plane)';
const MAX_VENDOR_MESSAGE = 120;

export interface GitHubCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute path under the API origin. No query, no fragment: every parameter is a validated path segment. */
  readonly path: string;
  /** App JWT or installation token. */
  readonly bearer: string;
  readonly body?: JsonValue;
}

export function githubUrl(path: string): string {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..')) throw new Error('invalid GitHub API path');
  return `${GITHUB_API_ORIGIN}${path}`;
}

/** One API call. HTTP-level failures (redirect, timeout, oversize, undecodable) become `api_error` with the reason. */
export async function callGitHub(fetcher: Fetcher, call: GitHubCall, limits: HttpLimits = HTTP_LIMITS): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${call.bearer}`,
    'user-agent': USER_AGENT,
    'x-github-api-version': GITHUB_API_VERSION,
  };
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetchJson(
      fetcher,
      githubUrl(call.path),
      { method: call.method, headers, ...(call.body === undefined ? {} : { body: canonicalJson(call.body) }) },
      limits,
    );
  } catch (error) {
    if (error instanceof HttpError) refuse('api_error', `${call.method} ${call.path}: ${error.reason}`);
    throw error;
  }
}

/** GitHub's `message` field, bounded and single-line, for operator-facing detail strings. */
export function vendorMessage(body: unknown): string {
  if (!isPlainObject(body) || typeof body['message'] !== 'string') return '';
  return body['message'].replace(/\s+/g, ' ').trim().slice(0, MAX_VENDOR_MESSAGE);
}

export function describeStatus(label: string, status: number, body: unknown): string {
  const message = vendorMessage(body);
  return message.length === 0 ? `${label}: ${status}` : `${label}: ${status} ${message}`;
}
