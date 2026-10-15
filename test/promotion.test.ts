import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateMessage, prepare, promote, retryFollowups, shadowBranch } from '../src/promotion.ts';
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
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
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
  await promote(promoteRequest(p.candidate_sha), h.deps);
  const patchesBefore = h.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/heads/main')).length;
  const tagsBefore = h.gh.tags.size;
  const again = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(again.ok, true);
  if (again.ok && again.action === 'promote') assert.equal(again.already_promoted, true);
  assert.equal(h.gh.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/heads/main')).length, patchesBefore);
  assert.equal(h.gh.tags.size, tagsBefore);
  assert.equal(h.gh.comments.length, 1);
});

test('promote refusals: no shadow, candidate mismatch, head moved after prepare, tree tampered, parents tampered', async () => {
  {
    const h = harness();
    const r = await promote(promoteRequest('f'.repeat(40)), h.deps);
    assert.equal(!r.ok && r.code, 'no_shadow');
  }
  {
    const h = harness();
    await prepared(h);
    const r = await promote(promoteRequest('f'.repeat(40)), h.deps);
    assert.equal(!r.ok && r.code, 'candidate_mismatch');
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.pulls.get(7)!.head = h.gh.commit('tree-sneaky', [h.head], 'push after review');
    const r = await promote(promoteRequest(p.candidate_sha), h.deps);
    assert.equal(!r.ok && r.code, 'head_moved');
    assert.equal(h.gh.branch('main'), h.main);
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.commits.get(p.candidate_sha)!.tree = 'tree-tampered';
    const r = await promote(promoteRequest(p.candidate_sha), h.deps);
    assert.equal(!r.ok && r.code, 'tree_mismatch');
    assert.equal(h.gh.branch('main'), h.main);
  }
  {
    const h = harness();
    const p = await prepared(h);
    h.gh.commits.get(p.candidate_sha)!.parents = [h.main, h.head];
    const r = await promote(promoteRequest(p.candidate_sha), h.deps);
    assert.equal(!r.ok && r.code, 'candidate_mismatch');
  }
});

test('stale base: main moved after prepare, the promoter rebuilds and hands back the new candidate', async () => {
  const h = harness();
  const p = await prepared(h);
  const moved = h.gh.commit('tree-hotfix', [h.main], 'fix: hotfix');
  h.gh.refs.set('heads/main', { type: 'commit', sha: moved });
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'stale_base');
  assert.ok(r.candidate_sha !== undefined && r.candidate_sha !== p.candidate_sha);
  assert.equal(h.gh.branch('main'), moved, 'main untouched');
  assert.equal(h.gh.branch('shadow/pr-7'), r.candidate_sha);
  assert.deepEqual(h.gh.commits.get(r.candidate_sha!)?.parents, [moved]);
  const old = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(!old.ok && old.code, 'candidate_mismatch', 'the stale candidate can never be promoted');
  const fresh = await promote(promoteRequest(r.candidate_sha!), h.deps);
  assert.equal(fresh.ok, true);
  assert.equal(h.gh.branch('main'), r.candidate_sha);
});

test('race: main moves between the check and the update; GitHub refuses the non-fast-forward', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'GET' && call.path.endsWith('/git/commits/' + p.candidate_sha)) {
      h.gh.refs.set('heads/main', { type: 'commit', sha: h.gh.commit('tree-race', [h.main], 'race') });
      h.gh.after = undefined;
    }
  };
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(!r.ok && r.code, 'not_fast_forward');
  assert.notEqual(h.gh.branch('main'), p.candidate_sha);
});

test('readback mismatch is reported, not assumed', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/heads/main')) h.gh.refs.set('heads/main', { type: 'commit', sha: h.main });
  };
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(!r.ok && r.code, 'readback_mismatch');
});

test('follow-up failures after main moved stay pending and are retried; the promotion itself stands', async () => {
  const h = harness();
  const p = await prepared(h);
  h.gh.fail('POST', /\/issues\/7\/comments$/, 502);
  h.gh.fail('DELETE', /\/git\/refs\/heads\/shadow\/pr-7$/, 500);
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(r.ok, true);
  if (!r.ok || r.action !== 'promote') return;
  assert.deepEqual([...r.pending].sort(), ['cleanup', 'comment']);
  assert.equal(h.gh.branch('main'), p.candidate_sha);
  assert.equal(h.deps.store.pendingFollowups().length, 1);
  const remaining = await retryFollowups(REPO, h.deps);
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
  const r = await promote(promoteRequest(p.candidate_sha), h.deps);
  assert.equal(r.ok, true);
  if (r.ok && r.action === 'promote') assert.deepEqual(r.pending, ['tag']);
  assert.equal(h.gh.refs.get(`tags/${tag}`)?.sha, h.main);
});

test('the promoter never sends force: true to main, never writes outside the repo, and never logs the token', async () => {
  const h = harness();
  const p = await prepared(h);
  await promote(promoteRequest(p.candidate_sha), h.deps);
  for (const c of h.gh.calls) {
    assert.ok(c.path.startsWith(`/repos/${REPO}/`), c.path);
    if (c.method === 'PATCH' && c.path.endsWith('/heads/main')) assert.equal((c.body as { force: boolean }).force, false);
  }
  assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
  assert.ok(h.logs.some((l) => l['event'] === 'promote' && l['outcome'] === 'promoted'));
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
