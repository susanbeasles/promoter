import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefusalError } from '../src/refusal.ts';
import { parseRequest, validateRequest } from '../src/request.ts';
import { prepareRequest, promoteRequest } from './helpers.ts';

const OWNER = 'susanbeasles';
const code = (value: unknown): string => {
  try {
    validateRequest(value, OWNER);
  } catch (error) {
    if (error instanceof RefusalError) return error.code;
    throw error;
  }
  return 'accepted';
};
const clone = <T>(v: T): any => JSON.parse(JSON.stringify(v));

test('valid prepare and promote requests parse and freeze', () => {
  const p = validateRequest(clone(prepareRequest('a'.repeat(40))), OWNER);
  assert.equal(p.action, 'shadow.prepare');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.subject));
  const q = validateRequest(clone(promoteRequest('b'.repeat(40), 'c'.repeat(40))), OWNER);
  assert.equal(q.action, 'promote');
  if (q.action === 'promote') assert.equal(q.evidence.checks.length, 2);
});

test('every malformed request has a stable code', () => {
  const prep = () => clone(prepareRequest('a'.repeat(40)));
  const prom = () => clone(promoteRequest('b'.repeat(40), 'c'.repeat(40)));
  const cases: [string, any][] = [
    ['bad_shape', []],
    ['bad_action', { ...prep(), action: 'merge' }],
    ['bad_version', { ...prep(), v: 2 }],
    ['unknown_key', { ...prep(), extra: 1 }],
    ['bad_repo', { ...prep(), subject: { ...prep().subject, repo: 'attacker/deployer' } }],
    ['bad_repo', { ...prep(), subject: { ...prep().subject, repo: 'susanbeasles/..' } }],
    ['bad_repo', { ...prep(), subject: { ...prep().subject, repo: 'susanbeasles/a/b' } }],
    ['bad_repo_id', { ...prep(), subject: { ...prep().subject, repo_id: '1' } }],
    ['bad_pr', { ...prep(), subject: { ...prep().subject, pr: 0 } }],
    ['bad_subject', (() => { const v = prom(); delete v.subject.head_sha; return v; })()],
    ['bad_sha', { ...prom(), subject: { ...prom().subject, head_sha: 'C'.repeat(40) } }],
    ['bad_sha', { ...prep(), subject: { ...prep().subject, head_sha: 'A'.repeat(40) } }],
    ['unknown_key', { ...prep(), subject: { ...prep().subject, candidate_sha: 'a'.repeat(40) } }],
    ['bad_requested_by', { ...prep(), requested_by: { sub: 'x y' } }],
    ['bad_requested_by', { ...prep(), requested_by: { sub: 'x', run_id: 5 } }],
    ['bad_shape', (({ evidence: _e, ...rest }) => rest)(prom())],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, checks: [] } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, checks: [{ ...prom().evidence.checks[0], conclusion: 'failure' }] } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, checks: [prom().evidence.checks[0], prom().evidence.checks[0]] } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, attestations: [{ digest: 'sha256:abc', bundle_url: 'https://api.github.com/x' }] } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, attestations: [{ digest: `sha256:${'a'.repeat(64)}`, bundle_url: 'https://evil.example/x' }] } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, shadow_run_id: -1 } }],
    ['bad_evidence', { ...prom(), evidence: { ...prom().evidence, decision_id: 'short' } }],
  ];
  for (const [expected, value] of cases) assert.equal(code(value), expected, JSON.stringify(value).slice(0, 160));
});

test('bytes are bounded and fatally decoded', () => {
  const asCode = (bytes: Uint8Array): string => {
    try {
      parseRequest(bytes, OWNER);
      return 'accepted';
    } catch (error) {
      return error instanceof RefusalError ? error.code : 'threw';
    }
  };
  assert.equal(asCode(new Uint8Array([0x7b, 0xff])), 'bad_encoding');
  assert.equal(asCode(new TextEncoder().encode('{')), 'bad_json');
  assert.equal(asCode(new Uint8Array(70_000).fill(0x20)), 'too_large');
  assert.equal(asCode(new TextEncoder().encode(JSON.stringify(prepareRequest('a'.repeat(40))))), 'accepted');
});
