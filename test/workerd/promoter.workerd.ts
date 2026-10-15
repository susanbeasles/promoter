// The promoter's deploy bundle (`wrangler deploy --dry-run` output) running in workerd through Miniflare.
// The only seam is the network: every outbound request goes to the in-memory FakeGitHub, including the App
// installation-token exchange, whose JWT is verified against the test key. A caller Worker reaches the
// Promoter entrypoint over a real service binding, exactly as the authorizer does.
//
// The crash test kills workerd while `main` has advanced and the promoter has not yet seen the response, then
// starts a fresh workerd on the same persisted Durable Object storage. That is the real failure: the intent is
// on disk (the output gate held the PATCH until it was), the in-memory state is gone.
//
// Run with `npm run -s test:workerd` (builds the bundle first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import { FakeGitHub, OWNER_ID, REPO_ID } from '../fake-github.ts';
import type { HttpRequestInit } from '../../src/http.ts';
import { prepareRequest, promoteRequest } from '../helpers.ts';

const BUNDLE = process.env['PROMOTER_BUNDLE'] ?? new URL('../../.wrangler/dry-run/index.js', import.meta.url);
const STORE = 'b6504fe2d5f64352954629bc7185fb79';
const APP_ID = '1234567';
const INSTALLATION_ID = '7654321';
const MINTED = 'ghs_workerd_minted_installation_token';

const CALLER = `export default { async fetch(request, env) {
  const { method, arg } = await request.json();
  return Response.json(await env.PROMOTER[method](arg));
} };`;

interface Key { pem: string; publicKey: webcrypto.CryptoKey }

async function appKey(): Promise<Key> {
  const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

/** Verifies the App JWT the promoter signed: RS256, issued by the App id, short-lived. */
async function verifyAppJwt(authorization: string | null, key: Key): Promise<boolean> {
  const jwt = authorization?.replace(/^Bearer /i, '') ?? '';
  const [h, p, s] = jwt.split('.');
  if (h === undefined || p === undefined || s === undefined) return false;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const valid = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
  return valid && header.alg === 'RS256' && String(claims.iss) === APP_ID && claims.exp - claims.iat <= 600;
}

interface World {
  gh: FakeGitHub;
  main: string;
  head: string;
  key: Key;
  persist: string;
  /** Set to make the next PATCH of heads/main apply on GitHub and then never answer, and kill workerd. */
  crashOnMainUpdate: boolean;
  outbound: string[];
  minted: number;
}

async function world(): Promise<World> {
  const { gh, main, head } = FakeGitHub.seeded();
  return { gh, main, head, key: await appKey(), persist: mkdtempSync(join(tmpdir(), 'promoter-do-')), crashOnMainUpdate: false, outbound: [], minted: 0 };
}

interface Runtime {
  call(method: 'prepare' | 'promote', arg: unknown): Promise<any>;
  kill(): Promise<void>;
  dispose(): Promise<void>;
}

async function boot(w: World): Promise<Runtime> {
  const script = readFileSync(BUNDLE, 'utf8');
  let mf: Miniflare | undefined;
  let crashed: (() => void) | undefined;
  const outbound = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    w.outbound.push(`${request.method} ${url.pathname}`);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    if (url.origin === 'https://api.github.com' && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens` && request.method === 'POST') {
      if (!(await verifyAppJwt(headers['authorization'] ?? null, w.key))) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      const body = JSON.parse(text);
      w.minted += 1;
      return Response.json({
        token: MINTED,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions,
        repositories: body.repository_ids.map((id: number) => ({ id })),
      }, { status: 201 });
    }
    const init: HttpRequestInit = { method: request.method as HttpRequestInit['method'], headers, redirect: 'manual', signal: AbortSignal.timeout(10_000), ...(text === '' ? {} : { body: text }) };
    const response = (await w.gh.fetcher(request.url, init)) as unknown as Response;
    if (w.crashOnMainUpdate && request.method === 'PATCH' && url.pathname.endsWith('/git/refs/heads/main') && response.status === 200) {
      // GitHub applied the update. The promoter never hears back: workerd dies now.
      w.crashOnMainUpdate = false;
      crashed?.();
      return new Promise<Response>(() => undefined);
    }
    return response;
  };
  // Miniflare 5 persists through `resourcePersistencePath`; the v4 `durableObjectsPersist` key is not converted.
  mf = new Miniflare({ ...convertV4MiniflareOptions({
    workers: [
      {
        name: 'promoter', modules: true, script, compatibilityDate: '2026-10-01', compatibilityFlags: ['global_fetch_strictly_public'],
        bindings: { GITHUB_APP_ID: APP_ID, GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID, GH_OWNER: 'susanbeasles', GH_OWNER_ID: String(OWNER_ID) },
        durableObjects: { LEDGER: { className: 'PromotionLedger', useSQLite: true } },
        secretsStoreSecrets: { GITHUB_APP_KEY: { store_id: STORE, secret_name: 'PROMOTER_APP_KEY' } },
        outboundService: outbound,
      },
      { name: 'caller', modules: true, script: CALLER, compatibilityDate: '2026-10-01', serviceBindings: { PROMOTER: { name: 'promoter', entrypoint: 'Promoter' } } },
    ],
  } as any), resourcePersistencePath: w.persist } as any);
  await (await mf.getSecretsStoreSecretAPI('GITHUB_APP_KEY', 'promoter'))().create(w.key.pem);
  const kill = async (): Promise<void> => {
    const current = mf;
    mf = undefined;
    await current?.dispose();
  };
  return {
    async call(method, arg) {
      if (mf === undefined) throw new Error('runtime is down');
      const caller = await mf.getWorker('caller');
      const crash = new Promise<'crashed'>((resolve) => { crashed = () => resolve('crashed'); });
      const answer = caller.fetch('http://caller/', { method: 'POST', body: JSON.stringify({ method, arg }) }).then((r) => r.json());
      answer.catch(() => undefined);
      const outcome = await Promise.race([answer, crash]);
      if (outcome === 'crashed') { await kill(); return 'crashed'; }
      return outcome;
    },
    kill,
    dispose: kill,
  };
}

function cleanup(w: World): void {
  rmSync(w.persist, { recursive: true, force: true });
}

const pulls = (w: World) => w.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/main'));
const tagMessages = (w: World) => [...w.gh.tags.values()].map((t) => t.message);

test('workerd: prepare then promote fast-forwards main, tags, and every GitHub call used the minted repo-scoped token', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(w.gh.branch('shadow/pr-7'), prepared.candidate_sha);
    const promoted = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
    assert.equal(w.gh.branch('main'), prepared.candidate_sha);
    assert.deepEqual(promoted.pending, []);
    assert.equal(w.gh.tags.size, 1);
    assert.match(tagMessages(w)[0] ?? '', /dec_0123456789abcdef/);
    assert.equal(w.gh.pulls.get(7)?.state, 'closed');
    assert.ok(w.gh.calls.every((c) => c.auth === `Bearer ${MINTED}` || c.auth === `token ${MINTED}`), 'only the minted installation token reaches /repos');
    assert.ok(w.outbound.every((line) => line.includes('/repos/susanbeasles/deployer/') || line.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)), w.outbound.join('\n'));
    assert.ok(pulls(w).every((c) => (c.body as any)?.force === false), 'main is only ever updated with force: false');
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: replay of the same promotion is idempotent: one ref move, one tag', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    const first = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    const again = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(first.already_promoted, false);
    assert.equal(again.ok, true);
    assert.equal(again.already_promoted, true);
    assert.equal(pulls(w).length, 1);
    assert.equal(w.gh.tags.size, 1);
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: concurrent promotions of the same candidate serialize in the Durable Object: exactly one moves main', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    const results = await Promise.all([1, 2, 3].map(() => rt.call('promote', promoteRequest(prepared.candidate_sha))));
    assert.ok(results.every((r) => r.ok === true), JSON.stringify(results));
    assert.equal(results.filter((r) => r.already_promoted === false).length, 1);
    assert.equal(pulls(w).length, 1);
    assert.equal(w.gh.tags.size, 1);
    assert.equal(w.gh.branch('main'), prepared.candidate_sha);
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: a PR head that moved after prepare is refused and main does not move', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    const pull = w.gh.pulls.get(7);
    assert.ok(pull);
    pull.head = w.gh.commit('tree-pushed-later', [w.head], 'fix: late push');
    const refused = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'head_moved');
    assert.equal(w.gh.branch('main'), w.main);
    assert.equal(pulls(w).length, 0);
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: stale main refuses with a rebuilt candidate; the old candidate can never be promoted', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    const moved = w.gh.commit('tree-other-merge', [w.main], 'feat: someone else landed');
    w.gh.refs.set('heads/main', { type: 'commit', sha: moved });
    const stale = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'stale_base');
    assert.match(stale.candidate_sha, /^[0-9a-f]{40}$/);
    assert.notEqual(stale.candidate_sha, prepared.candidate_sha);
    assert.equal(w.gh.branch('main'), moved);
    const old = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(old.ok, false);
    assert.equal(w.gh.branch('main'), moved, 'the stale candidate never lands');
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: partial failure after main moved stays pending and a retry completes it without moving main again', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    w.gh.fail('POST', /\/issues\/7\/comments$/, 502, true);
    const first = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(first.ok, true);
    assert.ok(first.pending.includes('comment'), JSON.stringify(first));
    assert.equal(w.gh.branch('main'), prepared.candidate_sha);
    w.gh.failures.length = 0;
    const retry = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.pending, []);
    assert.equal(w.gh.comments.length, 1);
    assert.equal(pulls(w).length, 1);
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd crash: killed after main advanced and before the tag; a fresh runtime tags from the persisted evidence only', async () => {
  const w = await world();
  let rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    w.crashOnMainUpdate = true;
    const outcome = await rt.call('promote', promoteRequest(prepared.candidate_sha));
    assert.equal(outcome, 'crashed');
    assert.equal(w.gh.branch('main'), prepared.candidate_sha, 'GitHub applied the update before the crash');
    assert.equal(w.gh.tags.size, 0, 'no tag was written before the crash');

    rt = await boot(w);
    // A later request carrying different evidence must not change what the tag records.
    const forged = promoteRequest(prepared.candidate_sha);
    const different = { ...forged, evidence: { ...forged.evidence, decision_id: 'dec_ffffffffffffffff', shadow_run_id: 999 } };
    const settled = await rt.call('promote', different);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.main_sha, prepared.candidate_sha);
    assert.equal(w.gh.tags.size, 1);
    const message = tagMessages(w)[0] ?? '';
    assert.match(message, /dec_0123456789abcdef/, 'tag carries the evidence persisted before main moved');
    assert.doesNotMatch(message, /dec_ffffffffffffffff/);
    assert.equal(pulls(w).length, 1, 'main was updated exactly once');
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd crash: after the restart, prepare settles the in-flight promotion first and never builds a second candidate', async () => {
  const w = await world();
  let rt = await boot(w);
  try {
    const prepared = await rt.call('prepare', prepareRequest(w.head));
    w.crashOnMainUpdate = true;
    assert.equal(await rt.call('promote', promoteRequest(prepared.candidate_sha)), 'crashed');
    rt = await boot(w);
    const again = await rt.call('prepare', prepareRequest(w.head));
    assert.equal(again.ok, false);
    assert.equal(again.code, 'already_promoted');
    assert.equal(w.gh.tags.size, 1, 'reconciliation wrote the tag');
    assert.equal(w.gh.branch('main'), prepared.candidate_sha);
  } finally { await rt.dispose(); cleanup(w); }
});

test('workerd: the minted token is scoped to the request repository and refusals carry no secret', async () => {
  const w = await world();
  const rt = await boot(w);
  try {
    const foreign = { ...prepareRequest(w.head), subject: { ...prepareRequest(w.head).subject, repo_id: REPO_ID + 1 } };
    const refused = await rt.call('prepare', foreign);
    assert.equal(refused.ok, false);
    assert.doesNotMatch(JSON.stringify(refused), new RegExp(MINTED));
    assert.doesNotMatch(JSON.stringify(refused), /PRIVATE KEY/);
  } finally { await rt.dispose(); cleanup(w); }
});
