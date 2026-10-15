import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstallationTokenSource, InstallationTokenCache, mintAppJwt } from '../src/github-app.ts';
import type { Fetcher } from '../src/http.ts';
import { decodePkcs8Pem, importPkcs8Pem, KeyError } from '../src/pkcs8.ts';
import { RefusalError } from '../src/refusal.ts';

async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

test('the App JWT is RS256, verifiable with the public key, backdated and under ten minutes', async () => {
  const { pem, publicKey } = await keypair();
  const key = await importPkcs8Pem(pem);
  const jwt = await mintAppJwt(key, '12345', Date.parse('2026-10-15T12:00:00Z'));
  const [h, c, s] = jwt.split('.');
  const dec = (x: string) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h!), { alg: 'RS256', typ: 'JWT' });
  const claims = dec(c!);
  assert.equal(claims.iss, '12345');
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(s!, 'base64url'), new TextEncoder().encode(`${h}.${c}`)));
});

test('PEM problems are named, never echoed', () => {
  const cases: [string, string][] = [
    ['-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', 'pkcs1_not_pkcs8'],
    ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----', 'encrypted'],
    ['garbage', 'not_pkcs8_pem'],
    ['-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----', 'bad_base64'],
  ];
  for (const [pem, problem] of cases) {
    assert.throws(() => decodePkcs8Pem(pem), (e: unknown) => e instanceof KeyError && e.problem === problem && !e.message.includes('AAAA'));
  }
});

test('installation tokens are scoped to one repository, cached, and a broader grant is refused', async () => {
  const { pem } = await keypair();
  const key = await importPkcs8Pem(pem);
  const requests: any[] = [];
  let scope: unknown[] = [{ id: 77 }];
  const fetcher: Fetcher = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body ?? '{}') });
    return new Response(JSON.stringify({ token: 'ghs_test_token_value_123', expires_at: '2026-10-15T13:00:00Z', permissions: { contents: 'write', pull_requests: 'write' }, repositories: scope }), { status: 201 }) as any;
  };
  const source = createInstallationTokenSource({ fetcher, key: async () => key, identity: { appId: '1', installationId: '2' }, clock: () => Date.parse('2026-10-15T12:00:00Z'), cache: new InstallationTokenCache() });
  assert.equal(await source(77), 'ghs_test_token_value_123');
  assert.equal(await source(77), 'ghs_test_token_value_123');
  assert.equal(requests.length, 1, 'cached');
  assert.equal(requests[0].url, 'https://api.github.com/app/installations/2/access_tokens');
  assert.deepEqual(requests[0].body, { permissions: { contents: 'write', pull_requests: 'write' }, repository_ids: [77] });
  scope = [{ id: 77 }, { id: 78 }];
  await assert.rejects(source(78), (e: unknown) => e instanceof RefusalError && e.code === 'repo_mismatch');
});
