import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqlShadowStore, type ShadowRecord } from '../src/store.ts';
import { sqlite } from './helpers.ts';

const rec: ShadowRecord = { repo_id: 5, pr: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), tree_sha: 'c'.repeat(40), candidate_sha: 'd'.repeat(40), state: 'prepared', prepared_at: 't', promoted_at: null, tag: null, pending: [], provenance_message: null, evidence: null };

test('records round-trip, update in place, and list pending follow-ups', () => {
  const store = new SqlShadowStore(sqlite(), 5);
  assert.equal(store.get(1), undefined);
  store.put(rec);
  assert.deepEqual(store.get(1), rec);
  store.put({ ...rec, state: 'promoted', tag: 'promote/pr-1-dddddddddddd', pending: ['comment'] });
  assert.deepEqual(store.pendingFollowups().map((r) => r.pending), [['comment']]);
  store.put({ ...rec, state: 'promoted', pending: [] });
  assert.equal(store.pendingFollowups().length, 0);
});

test('a store refuses records of another repository and invalid states', () => {
  const sql = sqlite();
  const store = new SqlShadowStore(sql, 5);
  assert.throws(() => store.put({ ...rec, repo_id: 6 }), /another repository/);
  store.put({ ...rec, pr: 3, state: 'advancing', evidence: '{"x":1}' });
  assert.deepEqual(store.advancing().map((r) => [r.pr, r.evidence]), [[3, '{"x":1}']]);
  assert.throws(() => sql.exec("INSERT INTO shadow (pr, repo_id, head_sha, base_sha, tree_sha, candidate_sha, state, prepared_at) VALUES (2, 5, 'a', 'b', 'c', 'd', 'weird', 't')"), /CHECK/);
});

test('legacy shadow rows migrate without losing state, and preserve the canonical provenance bytes on restart', () => {
  const sql = sqlite();
  sql.exec(`CREATE TABLE shadow (pr INTEGER PRIMARY KEY, repo_id INTEGER, head_sha TEXT, base_sha TEXT, tree_sha TEXT, candidate_sha TEXT, state TEXT, prepared_at TEXT, promoted_at TEXT, tag TEXT, pending TEXT DEFAULT '[]', evidence TEXT)`);
  sql.exec("INSERT INTO shadow (pr,repo_id,head_sha,base_sha,tree_sha,candidate_sha,state,prepared_at) VALUES (1,5,'a','b','c','d','prepared','t')");
  const migrated = new SqlShadowStore(sql, 5);
  assert.equal(migrated.get(1)?.candidate_sha, 'd');
  assert.equal(migrated.get(1)?.provenance_message, null);
  migrated.put({ ...rec, provenance_message: 'canonical message bytes' });
  assert.equal(new SqlShadowStore(sql, 5).get(1)?.provenance_message, 'canonical message bytes');
});
