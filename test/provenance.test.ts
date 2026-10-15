import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTagMessage, tagMessage, tagName } from '../src/provenance.ts';
import type { ShadowRecord } from '../src/store.ts';
import { promoteRequest } from './helpers.ts';

const record: ShadowRecord = {
  repo_id: 1,
  pr: 42,
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  tree_sha: 'c'.repeat(40),
  candidate_sha: '0123456789abcdef0123456789abcdef01234567',
  state: 'promoted',
  prepared_at: '2026-10-15T12:00:00.000Z',
  promoted_at: '2026-10-15T12:05:00.000Z',
  tag: null,
  pending: [],
  evidence: null,
};

test('tag names are stable and short', () => {
  assert.equal(tagName(42, record.candidate_sha), 'promote/pr-42-0123456789ab');
});

test('the tag message carries canonical JSON and its digest; any edit is detected', async () => {
  const input = { repo: 'susanbeasles/x', record, prTitle: 'feat: y', evidence: promoteRequest(record.candidate_sha).evidence, promotedAt: record.promoted_at!, promoterVersion: '0.2.0' };
  const { message, sha256 } = await tagMessage(input);
  assert.match(message, /^Promote PR #42 to main as 0123456789ab\n\n\{"attestations":/);
  assert.ok(message.trimEnd().endsWith(`sha256:${sha256}`));
  const parsed = await readTagMessage(message);
  assert.equal(parsed?.['candidate_sha'], record.candidate_sha);
  assert.equal(parsed?.['schema'], 'promotion-provenance/v1');
  assert.equal(await readTagMessage(message.replace('"pr":42', '"pr":43')), undefined);
  assert.equal(await readTagMessage('no structure'), undefined);
  assert.equal((await tagMessage(input)).sha256, sha256, 'deterministic');
});
