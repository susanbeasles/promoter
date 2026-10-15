// The one way out of this Worker: fetch with `redirect: 'error'`, a timeout, a bounded body and a fatal
// JSON decode. Errors carry a reason and nothing from the request: no URL, no headers, no body.

import { concatBytes, decodeJson, DecodeError } from './decode.ts';

export interface HttpHeaders {
  get(name: string): string | null;
}

/** The parts of a `Response` this Worker reads. A real `Response` satisfies it; tests build one from a string. */
export interface HttpResponseLike {
  readonly status: number;
  readonly headers: HttpHeaders;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface HttpRequestInit {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

export type Fetcher = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface HttpLimits {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export const HTTP_LIMITS: HttpLimits = Object.freeze({ timeoutMs: 15_000, maxBodyBytes: 1_048_576 });

export type HttpFailure = 'network' | 'timeout' | 'redirect' | 'too_large' | 'bad_encoding' | 'bad_json';

export class HttpError extends Error {
  readonly reason: HttpFailure;
  constructor(reason: HttpFailure) {
    super(reason);
    this.name = 'HttpError';
    this.reason = reason;
  }
}

export interface JsonResponse {
  readonly status: number;
  /** Parsed body, or `null` when the body was empty. */
  readonly body: unknown;
}

async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new HttpError('too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return concatBytes(chunks, total);
}

function classify(error: unknown): HttpFailure {
  if (error instanceof HttpError) return error.reason;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    if (/redirect/i.test(error.message)) return 'redirect';
  }
  return 'network';
}

/**
 * One JSON request. Never follows a redirect (a 3xx rejects), never waits longer than `timeoutMs`, never reads
 * more than `maxBodyBytes`, never accepts a body that is not valid UTF-8 JSON. The returned status is the
 * caller's to interpret.
 */
export async function fetchJson(
  fetcher: Fetcher,
  url: string,
  init: { readonly method: HttpRequestInit['method']; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
  limits: HttpLimits = HTTP_LIMITS,
): Promise<JsonResponse> {
  const request: HttpRequestInit = {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: 'error',
    signal: AbortSignal.timeout(limits.timeoutMs),
  };
  let response: HttpResponseLike;
  let bytes: Uint8Array;
  try {
    response = await fetcher(url, request);
    bytes = await readBounded(response.body, limits.maxBodyBytes);
  } catch (error) {
    throw new HttpError(classify(error));
  }
  // A 3xx must never arrive here (redirect: 'error' rejects), but a fetcher that disobeys is still refused.
  if (response.status >= 300 && response.status < 400) throw new HttpError('redirect');
  if (bytes.byteLength === 0) return { status: response.status, body: null };
  try {
    return { status: response.status, body: decodeJson(bytes, limits.maxBodyBytes) };
  } catch (error) {
    if (error instanceof DecodeError) throw new HttpError(error.reason);
    throw error;
  }
}
