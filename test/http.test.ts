import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson, HttpError, type HttpRequestInit, type HttpResponseLike } from '../src/http.ts';

function response(status: number, text: string, onCancel?: () => void): HttpResponseLike {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(bytes); controller.close(); },
    cancel() { onCancel?.(); },
  });
  return { status, headers: new Headers(), body };
}

test("requests use redirect: 'manual' (workerd rejects 'error')", async () => {
  let seen: HttpRequestInit | undefined;
  const result = await fetchJson(async (_url, init) => { seen = init; return response(200, '{"ok":true}'); }, 'https://api.github.com/x', { method: 'GET', headers: {} });
  assert.equal(seen?.redirect, 'manual');
  assert.ok(seen?.signal instanceof AbortSignal);
  assert.deepEqual(result, { status: 200, body: { ok: true } });
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${status} is refused as redirect and its body is cancelled, never read`, async () => {
    let cancelled = false;
    await assert.rejects(
      fetchJson(async () => response(status, '{"looks":"valid"}', () => { cancelled = true; }), 'https://api.github.com/x', { method: 'GET', headers: {} }),
      (error: unknown) => error instanceof HttpError && error.reason === 'redirect',
    );
    assert.equal(cancelled, true);
  });
}

test('a fetcher error mentioning "redirect" is a network failure, not a refused redirect', async () => {
  // workerd's message for an unsupported redirect mode contains the word; it must not masquerade as a 3xx.
  await assert.rejects(
    fetchJson(async () => { throw new TypeError('Invalid redirect value'); }, 'https://api.github.com/x', { method: 'GET', headers: {} }),
    (error: unknown) => error instanceof HttpError && error.reason === 'network',
  );
});
