import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateMessage, prepare, promote, reconcileAll, shadowBranch } from '../src/promotion.ts';
import { readTagMessage, tagName } from '../src/provenance.ts';
import { OWNER_ID, REPO, REPO_ID, treeSha } from './fake-github.ts';
import { harness, prepareRequest, promoteRequest, TOKEN } from './helpers.ts';

async function prepared(h: ReturnType<typeof harness>) {
  const result = await prepare(prepareRequest(h.head), h.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok || result.action !== 'shadow.prepare') throw new Error('unreachable');
  return result;
}

test('prepare builds a single-parent squash candidate on main with the merged tree, on shadow/pr-<n>', async () => {
  const h = harness();
  const r = await prepared(h);
  assert.equal(r.shadow_ref, 'refs/heads/shadow/pr-7');
  assert.equal(r.base_sha, h.main);
  assert.equal(h.gh.branch('shadow/pr-7'), r.candidate_sha);
  const candidate = h.gh.commits.get(r.candidate_sha);
  assert.ok(candidate);
  assert.deepEqual(candidate.parents, [h.main], 'exactly one parent: main stays linear');
  assert.equal(treeSha(candidate.tree), r.tree_sha);
  assert.equal(candidate.tree, 'merged(tree-root+tree-feature)');
  assert.match(candidate.message, /^feat: add thing \(#7\)\n\nAdds the thing\.\n\nPromoted-PR: #7\nPromoted-Head: [0-9a-f]{40}\nShadow-Base: [0-9a-f]{40}\nCo-authored-by: susanbeasles <215839550\+susanbeasles@users\.noreply\.github\.com>\n$/);
  assert.equal(h.gh.branch('main'), h.main, 'prepare never touches main');
  assert.ok(h.gh.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.equal(h.deps.store.get(7)?.state, 'prepared');
});

test('prepare is idempotent while head and main are unchanged, and rebuilds when main moved', async () => {
  const h = harness();
  const first = await prepared(h);
  const commitsBefore = h.gh.commits.size;
  const again = await prepared(h);
  assert.equal(again.reused, true);
  assert.equal(again.candidate_sha, first.candidate_sha);
  assert.equal(h.gh.commits.size, commitsBefore, 'no new commits on a repeat');
  const moved = h.gh.commit('tree-other', [h.main], 'fix: other');
  h.gh.refs.set('heads/main', { type: 'commit', sha: moved });
  const rebuilt = await prepared(h);
  assert.equal(rebuilt.reused, false);
  assert.equal(rebuilt.base_sha, moved);
  assert.notEqual(rebuilt.candidate_sha, first.candidate_sha);
});

test('prepare refusals: head moved, fork, closed, wrong base, foreign repo, conflict, nothing to promote', async () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
    ['head_moved', (h) => void (h.gh.pulls.get(7)!.head = h.main)],
    ['is_fork', (h) => void (h.gh.pulls.get(7)!.headRepoId = 999)],
    ['is_fork', (h) => void (h.gh.pulls.get(7)!.headRepoId = null)],
    ['not_open', (h) => void (h.gh.pulls.get(7)!.state = 'closed')],
    ['wrong_base', (h) => void (h.gh.pulls.get(7)!.baseRef = 'develop')],
    ['conflict', (h) => void h.gh.conflicts.add(h.head)],
  ];
  for (const [code, mutate] of cases) {
    const h = harness();
    mutate(h);
    const r = await prepare(prepareRequest(h.head), h.deps);
    assert.equal(r.ok, false, code);
    if (!r.ok) assert.equal(r.code, code);
    assert.equal(h.gh.branch('main'), h.main);
    if (code === 'conflict') assert.equal(h.gh.branch('shadow/pr-7'), undefined, 'a conflicted shadow branch is removed');
  }
  const h = harness();
  h.gh.pulls.get(7)!.head = h.main;
  const nothing = await prepare(prepareRequest(h.main), h.deps);
  assert.equal(nothing.ok, false);
  if (!nothing.ok) assert.equal(nothing.code, 'nothing_to_promote');
  const missing = await prepare(prepareRequest(h.head, 99), h.deps);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'not_open');
});

test('promote fast-forwards main to the exact candidate, tags provenance, comments, closes and cleans up', async () => {
  const h = harness();
  const p = await prepared(h);
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok || r.action !== 'promote') throw new Error('unreachable');
  assert.equal(r.main_sha, p.candidate_sha);
  assert.equal(r.already_promoted, false);
  assert.deepEqual(r.pending, []);
  assert.equal(h.gh.branch('main'), p.candidate_sha);
  const mainUpdate = h.gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/main'));
  assert.deepEqual(mainUpdate?.body, { force: false, sha: p.candidate_sha }, 'main is only ever moved with force: false');
  assert.equal(r.tag, tagName(7, p.candidate_sha));
  const ref = h.gh.refs.get(`tags/${r.tag}`);
  assert.equal(ref?.type, 'tag');
  const tagObject = h.gh.tags.get(ref!.sha);
  assert.equal(tagObject?.object, p.candidate_sha);
  const provenance = await readTagMessage(tagObject!.message);
  assert.ok(provenance, 'tag message carries verifiable provenance');
  assert.equal(provenance['schema'], 'promotion-provenance/v1');
  assert.equal(provenance['candidate_sha'], p.candidate_sha);
  assert.equal(provenance['head_sha'], h.head);
  assert.equal(provenance['base_sha'], h.main);
  assert.equal(provenance['tree_sha'], p.tree_sha);
  assert.equal(provenance['shadow_run_id'], 555);
  assert.equal(provenance['repo_id'], REPO_ID);
  assert.equal((provenance['checks'] as unknown[]).length, 2);
  assert.equal(h.gh.pulls.get(7)?.state, 'closed');
  assert.match(h.gh.comments[0]?.body ?? '', /Promoted to `main` as [0-9a-f]{40}/);
  assert.match(h.gh.comments[0]?.body ?? '', /actions\/runs\/555/);
  assert.equal(h.gh.branch(shadowBranch(7)), undefined);
  assert.equal(h.deps.store.get(7)?.state, 'promoted');
});

test('promote repeat is idempotent: same result, no second tag, no second ref move', async () => {
  const h = harness();
  const p = await prepared(h);
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  const patchesBefore = h.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/heads/main')).length;
  const tagsBefore = h.gh.tags.size;
  const again = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(again.ok, true);
  if (again.ok && again.action === 'promote') assert.equal(again.already_promoted, true);
  assert.equal(h.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/heads/main')).length, patchesBefore);
  assert.equal(h.gh.tags.size, tagsBefore);
  assert.equal(h.gh.comments.length, 1);
});

test('promote refusals: no shadow, candidate mismatch, head moved after prepare, tree tampered, parents tampered', async () => {
  {
    const h = harness();
    const r = await promote(promoteRequest('f'.repeat(40), h.head), h.deps);
    assert.equal(!r.ok && r.code, 'no_shadow');
  }
  {
    const h = harness();
    await prepared(h);
    const r = await promote(promoteRequest('f'.repeat(40), h.head), h.deps);
    assert.equal(!r.ok && r.code, 'candidate_mismatch');
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.pulls.get(7)!.head = h.gh.commit('tree-sneaky', [h.head], 'push after review');
    const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
    assert.equal(!r.ok && r.code, 'head_moved');
    assert.equal(h.gh.branch('main'), h.main);
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.commits.get(p.candidate_sha)!.tree = 'tree-tampered';
    const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
    assert.equal(!r.ok && r.code, 'tree_mismatch');
    assert.equal(h.gh.branch('main'), h.main);
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.commits.get(p.candidate_sha)!.parents = [h.main, h.head];
    const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
    assert.equal(!r.ok && r.code, 'candidate_mismatch');
  }
});

test('promote bound to a different PR head than the prepared one is refused; main does not move', async () => {
  const h = harness();
  const p = await prepared(h);
  const r = await promote(promoteRequest(p.candidate_sha, 'e'.repeat(40)), h.deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'head_moved');
  assert.equal(h.gh.branch('main'), h.main);
  assert.equal(h.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/main')).length, 0);
});

test('stale base: main moved after prepare, the promoter rebuilds and hands back the new candidate', async () => {
  const h = harness();
  const p = await prepared(h);
  const moved = h.gh.commit('tree-hotfix', [h.main], 'fix: hotfix');
  h.gh.refs.set('heads/main', { type: 'commit', sha: moved });
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'stale_base');
  assert.ok(r.candidate_sha !== undefined && r.candidate_sha !== p.candidate_sha);
  assert.equal(h.gh.branch('main'), moved, 'main untouched');
  assert.equal(h.gh.branch('shadow/pr-7'), r.candidate_sha);
  assert.deepEqual(h.gh.commits.get(r.candidate_sha!)?.parents, [moved]);
  const old = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!old.ok && old.code, 'candidate_mismatch', 'the stale candidate can never be promoted');
  const fresh = await promote(promoteRequest(r.candidate_sha!, h.head), h.deps);
  assert.equal(fresh.ok, true);
  assert.equal(h.gh.branch('main'), r.candidate_sha);
});

test('race: main moves after the first check; the final head recheck refuses and nothing is promoted', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'GET' && call.path.endsWith('/git/commits/' + p.candidate_sha)) {
      h.gh.refs.set('heads/main', { type: 'commit', sha: h.gh.commit('tree-race', [h.main], 'race') });
      h.gh.after = undefined;
    }
  };
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!r.ok && r.code, 'stale_base');
  assert.notEqual(h.gh.branch('main'), p.candidate_sha);
  assert.equal(h.deps.store.get(7)?.state, 'prepared', 'intent withdrawn');
  assert.equal(h.deps.store.get(7)?.evidence, null);
});

test('race after the final recheck: GitHub refuses the non-fast-forward update', async () => {
  const h = harness();
  const p = await prepared(h);
  let mainReads = 0;
  h.gh.after = (call) => {
    if (call.method === 'GET' && call.path.endsWith('/git/ref/heads/main') && ++mainReads === 2) {
      h.gh.refs.set('heads/main', { type: 'commit', sha: h.gh.commit('tree-race', [h.main], 'race') });
      h.gh.after = undefined;
    }
  };
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!r.ok && r.code, 'not_fast_forward');
  assert.notEqual(h.gh.branch('main'), p.candidate_sha);
  assert.equal(h.deps.store.get(7)?.state, 'prepared');
});

test('readback mismatch is reported, not assumed', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) h.gh.refs.set('heads/main', { type: 'commit', sha: h.main });
  };
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!r.ok && r.code, 'readback_mismatch');
});

test('follow-up failures after main moved stay pending and are retried; the promotion itself stands', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.fail('POST', /\/issues\/7\/comments$/, 502);
  h.gh.fail('DELETE', /\/git\/refs\/heads\/shadow\/pr-7$/, 500);
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(r.ok, true);
  if (!r.ok || r.action !== 'promote') return;
  assert.deepEqual([...r.pending].sort(), ['cleanup', 'comment']);
  assert.equal(h.gh.branch('main'), p.candidate_sha);
  assert.equal(h.deps.store.pendingFollowups().length, 1);
  const remaining = await reconcileAll(REPO, h.deps);
  assert.equal(remaining, 0);
  assert.equal(h.gh.comments.length, 1);
  assert.equal(h.gh.branch('shadow/pr-7'), undefined);
  assert.equal(h.deps.store.pendingFollowups().length, 0);
});

test('an existing tag pointing at another commit is never moved; the tag step stays pending', async () => {
  const h = harness();
  const p = await prepared(h);
  const tag = tagName(7, p.candidate_sha);
  h.gh.refs.set(`tags/${tag}`, { type: 'commit', sha: h.main });
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(r.ok, true);
  if (r.ok && r.action === 'promote') assert.deepEqual(r.pending, ['tag']);
  assert.equal(h.gh.refs.get(`tags/${tag}`)?.sha, h.main);
});

test('the promoter never sends force: true to main, never writes outside the repo, and never logs the token', async () => {
  const h = harness();
  const p = await prepared(h);
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  for (const c of h.gh.calls.filter((call) => call.method !== 'SCHEDULE')) {
    assert.ok(c.path.startsWith(`/repos/${REPO}/`), c.path);
    if (c.method === 'PATCH' && c.path.endsWith('/heads/main')) assert.equal((c.body as { force: boolean }).force, false);
  }
  assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
  assert.ok(h.logs.some((l) => l['event'] === 'promote' && l['outcome'] === 'promoted'));
});

test('intent and evidence are durable and reconciliation is armed before main moves', async () => {
  const h = harness();
  const p = await prepared(h);
  let stateAtUpdate: string | undefined;
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) stateAtUpdate = h.deps.store.get(7)?.state;
  };
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  const order = h.gh.calls.map((c) => c.method + ' ' + c.path.replace(/^.*\/git\//, ''));
  assert.ok(order.indexOf('SCHEDULE ') < order.indexOf('PATCH refs/heads/main'), order.join('\n'));
  assert.equal(stateAtUpdate, 'advancing');
  assert.equal(h.scheduled.length, 1);
});

test('crash after main advanced, before the tag: reconciliation completes from the persisted evidence only', async () => {
  const h = harness();
  const p = await prepared(h);
  // The update lands, then the process dies: every later call in this request fails.
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) h.gh.fail('GET', /.*/, 599, true);
  };
  const crashed = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(crashed.ok, false);
  assert.equal(h.gh.branch('main'), p.candidate_sha, 'main moved');
  assert.equal(h.deps.store.get(7)?.state, 'advancing');
  assert.equal(h.gh.refs.get(`tags/${tagName(7, p.candidate_sha)}`), undefined, 'no tag yet');
  h.gh.failures = [];
  h.gh.after = undefined;
  // A later request arrives with different evidence: it must not change what the tag says.
  const other = promoteRequest(p.candidate_sha, h.head);
  const forged = { ...other, evidence: { ...other.evidence, shadow_run_id: 999, decision_id: 'dec_forged_later_0001' } };
  const repeat = await promote(forged, h.deps);
  assert.equal(repeat.ok, true);
  if (repeat.ok && repeat.action === 'promote') {
    assert.equal(repeat.already_promoted, true);
    assert.equal(repeat.main_sha, p.candidate_sha);
  }
  const ref = h.gh.refs.get(`tags/${tagName(7, p.candidate_sha)}`);
  const provenance = await readTagMessage(h.gh.tags.get(ref!.sha)!.message);
  assert.equal(provenance?.['shadow_run_id'], 555, 'tag built from the evidence persisted before main moved');
  assert.equal(provenance?.['authorizer_decision'], 'dec_0123456789abcdef');
  assert.equal(provenance?.['candidate_sha'], p.candidate_sha);
  assert.equal(h.gh.tags.size, 1);
  assert.equal(h.deps.store.get(7)?.state, 'promoted');
});

test('crash after main advanced: the alarm alone completes the promotion', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) h.gh.fail('GET', /.*/, 599, true);
  };
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  h.gh.failures = [];
  h.gh.after = undefined;
  assert.equal(await reconcileAll(REPO, h.deps), 0);
  assert.equal(h.deps.store.get(7)?.state, 'promoted');
  assert.ok(h.gh.refs.get(`tags/${tagName(7, p.candidate_sha)}`));
  assert.equal(h.gh.pulls.get(7)?.state, 'closed');
});

test('update outcome unknown and not applied: reconciliation reverts and a fresh authorization retries', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.fail('PATCH', /\/git\/refs\/heads\/main$/, 504);
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!r.ok && r.code, 'api_error');
  assert.equal(h.deps.store.get(7)?.state, 'advancing');
  assert.equal(await reconcileAll(REPO, h.deps), 0);
  assert.equal(h.deps.store.get(7)?.state, 'prepared');
  assert.equal(h.deps.store.get(7)?.evidence, null);
  const retried = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(retried.ok, true);
  assert.equal(h.gh.branch('main'), p.candidate_sha);
});

test('advancing with main somewhere else is a conflict: no tag, no adoption, refusals until a human acts', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.fail('PATCH', /\/git\/refs\/heads\/main$/, 504);
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  h.gh.refs.set('heads/main', { type: 'commit', sha: h.gh.commit('tree-elsewhere', [h.main], 'elsewhere') });
  await reconcileAll(REPO, h.deps);
  assert.equal(h.deps.store.get(7)?.state, 'reconcile_conflict');
  assert.equal(h.gh.tags.size, 0);
  const again = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!again.ok && again.code, 'reconcile_conflict');
  const reprep = await prepare(prepareRequest(h.head), h.deps);
  assert.equal(!reprep.ok && reprep.code, 'reconcile_conflict');
  assert.ok(h.logs.some((l) => l['outcome'] === 'conflict' && l['severity'] === 'critical'));
});

test('main at the candidate without a recorded intent is never adopted', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.refs.set('heads/main', { type: 'commit', sha: p.candidate_sha });
  const r = await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  assert.equal(!r.ok && r.code, 'reconcile_conflict');
  assert.equal(h.gh.tags.size, 0);
});

test('prepare while a promotion is in flight settles it first and never builds a second candidate', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) h.gh.fail('GET', /.*/, 599, true);
  };
  await promote(promoteRequest(p.candidate_sha, h.head), h.deps);
  h.gh.failures = [];
  h.gh.after = undefined;
  h.gh.pulls.get(7)!.state = 'open';
  const commitsBefore = h.gh.commits.size;
  const r = await prepare(prepareRequest(h.head), h.deps);
  assert.equal(!r.ok && r.code, 'already_promoted');
  assert.equal(h.gh.commits.size, commitsBefore);
  assert.equal(h.deps.store.get(7)?.state, 'promoted');
});

test('candidate message bounds the body and keeps trailers', () => {
  const msg = candidateMessage(
    { number: 3, state: 'open', merged: false, title: 'x\ny', body: 'b'.repeat(5_000), author: { login: 'dependabot[bot]', id: 49699333 }, head: { sha: 'a'.repeat(40), repoId: 1 }, base: { ref: 'main', repoId: 1, ownerId: OWNER_ID } },
    'a'.repeat(40),
    'b'.repeat(40),
  );
  assert.match(msg, /^x y \(#3\)\n/);
  assert.match(msg, /\[body truncated by promoter\]/);
  assert.match(msg, /Co-authored-by: dependabot\[bot\] <49699333\+dependabot\[bot\]@users\.noreply\.github\.com>\n$/);
});
