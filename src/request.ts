// The two requests the authorizer sends: `shadow.prepare` and `promote`. Exact keys, fatal parser, stable codes.
// The authorizer already decided; this parser only makes sure the decision is well-formed before it is executed.

import { decodeJson, DecodeError } from './decode.ts';
import { isPlainObject, isPositiveInteger } from './json.ts';
import { refuse, type RequestCode } from './refusal.ts';

export interface RequestedBy {
  readonly sub: string;
  readonly run_id?: string;
}

export interface Target {
  /** `owner/name`, where owner is the configured GitHub owner. */
  readonly repo: string;
  readonly repo_id: number;
  readonly pr: number;
}

export interface PrepareRequest {
  readonly v: 1;
  readonly action: 'shadow.prepare';
  readonly subject: Target & { readonly head_sha: string };
  readonly requested_by: RequestedBy;
}

export type CheckConclusion = 'success' | 'neutral' | 'skipped';

export interface CheckEvidence {
  readonly name: string;
  readonly id: number;
  readonly conclusion: CheckConclusion;
  readonly completed_at: string;
}

export interface AttestationEvidence {
  /** `sha256:<64 hex>` of the attested subject. */
  readonly digest: string;
  readonly bundle_url: string;
}

/** What the authorizer verified before it called `promote`. Recorded in the provenance tag, never re-decided here. */
export interface Evidence {
  readonly checks: readonly CheckEvidence[];
  readonly attestations: readonly AttestationEvidence[];
  readonly shadow_run_id: number;
  readonly decision_id: string;
}

export interface PromoteRequest {
  readonly v: 1;
  readonly action: 'promote';
  readonly subject: Target & { readonly candidate_sha: string };
  readonly evidence: Evidence;
  readonly requested_by: RequestedBy;
}

export type PromotionRequest = PrepareRequest | PromoteRequest;

export const REQUEST_LIMITS = Object.freeze({ maxBytes: 65_536, maxChecks: 100, maxAttestations: 20, maxCheckName: 200 });

/** GitHub repository names: letters, digits, `-`, `_`, `.`; at most 100 characters; never a dot-only name (URL traversal). */
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export const SHA = /^[0-9a-f]{40}$/;
const SUBJECT_CLAIM = /^[A-Za-z0-9][A-Za-z0-9:_./@-]{0,255}$/;
const RUN_ID = /^[1-9][0-9]{0,18}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECISION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ATTESTATION_URL = /^https:\/\/api\.github\.com\/[A-Za-z0-9_./:%-]{1,400}$/;
const CONCLUSIONS: readonly CheckConclusion[] = ['success', 'neutral', 'skipped'];

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], missing: RequestCode): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse('unknown_key', key);
  for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) refuse(missing, `missing ${key}`);
}

export function splitRepo(repo: string): { readonly owner: string; readonly name: string } | undefined {
  const parts = repo.split('/');
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;
  if (owner === undefined || name === undefined || owner.length === 0) return undefined;
  if (!REPO_NAME.test(name) || /^\.+$/.test(name)) return undefined;
  return { owner, name };
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) refuse('bad_sha', field);
  return value;
}

function target(value: Record<string, unknown>, owner: string): Target {
  const repo = value['repo'];
  if (typeof repo !== 'string') refuse('bad_repo');
  const split = splitRepo(repo);
  if (split === undefined || split.owner !== owner) refuse('bad_repo');
  const repoId = value['repo_id'];
  if (!isPositiveInteger(repoId)) refuse('bad_repo_id');
  const pr = value['pr'];
  if (!isPositiveInteger(pr)) refuse('bad_pr');
  return { repo, repo_id: repoId, pr };
}

function requestedBy(value: unknown): RequestedBy {
  if (!isPlainObject(value)) refuse('bad_requested_by');
  for (const key of Object.keys(value)) if (key !== 'sub' && key !== 'run_id') refuse('bad_requested_by', key);
  const sub = value['sub'];
  if (typeof sub !== 'string' || !SUBJECT_CLAIM.test(sub)) refuse('bad_requested_by', 'sub');
  if (!Object.hasOwn(value, 'run_id')) return Object.freeze({ sub });
  const runId = value['run_id'];
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('bad_requested_by', 'run_id');
  return Object.freeze({ sub, run_id: runId });
}

function check(value: unknown): CheckEvidence {
  if (!isPlainObject(value)) refuse('bad_evidence', 'check');
  exactKeys(value, ['name', 'id', 'conclusion', 'completed_at'], [], 'bad_evidence');
  const name = value['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > REQUEST_LIMITS.maxCheckName || /[\u0000-\u001f\u007f]/.test(name)) refuse('bad_evidence', 'check name');
  const id = value['id'];
  if (!isPositiveInteger(id)) refuse('bad_evidence', 'check id');
  const conclusion = value['conclusion'];
  if (typeof conclusion !== 'string' || !CONCLUSIONS.includes(conclusion as CheckConclusion)) refuse('bad_evidence', 'check conclusion');
  const completedAt = value['completed_at'];
  if (typeof completedAt !== 'string' || !RFC3339_UTC.test(completedAt) || !Number.isFinite(Date.parse(completedAt))) refuse('bad_evidence', 'check completed_at');
  return Object.freeze({ name, id, conclusion: conclusion as CheckConclusion, completed_at: completedAt });
}

function attestation(value: unknown): AttestationEvidence {
  if (!isPlainObject(value)) refuse('bad_evidence', 'attestation');
  exactKeys(value, ['digest', 'bundle_url'], [], 'bad_evidence');
  const digest = value['digest'];
  if (typeof digest !== 'string' || !DIGEST.test(digest)) refuse('bad_evidence', 'attestation digest');
  const url = value['bundle_url'];
  if (typeof url !== 'string' || !ATTESTATION_URL.test(url) || url.includes('..')) refuse('bad_evidence', 'attestation bundle_url');
  return Object.freeze({ digest, bundle_url: url });
}

function evidence(value: unknown): Evidence {
  if (!isPlainObject(value)) refuse('bad_evidence');
  exactKeys(value, ['checks', 'attestations', 'shadow_run_id', 'decision_id'], [], 'bad_evidence');
  const checks = value['checks'];
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > REQUEST_LIMITS.maxChecks) refuse('bad_evidence', 'checks');
  const attestations = value['attestations'];
  if (!Array.isArray(attestations) || attestations.length > REQUEST_LIMITS.maxAttestations) refuse('bad_evidence', 'attestations');
  const runId = value['shadow_run_id'];
  if (!isPositiveInteger(runId)) refuse('bad_evidence', 'shadow_run_id');
  const decision = value['decision_id'];
  if (typeof decision !== 'string' || !DECISION_ID.test(decision)) refuse('bad_evidence', 'decision_id');
  const parsedChecks = checks.map(check);
  if (new Set(parsedChecks.map((c) => c.id)).size !== parsedChecks.length) refuse('bad_evidence', 'duplicate check id');
  return Object.freeze({
    checks: Object.freeze(parsedChecks),
    attestations: Object.freeze(attestations.map(attestation)),
    shadow_run_id: runId,
    decision_id: decision,
  });
}

/** Validate an already-parsed value. `owner` is the configured GitHub owner every repository must belong to. */
export function validateRequest(value: unknown, owner: string): PromotionRequest {
  if (!isPlainObject(value)) refuse('bad_shape');
  const action = value['action'];
  if (action === 'shadow.prepare') {
    exactKeys(value, ['v', 'action', 'subject', 'requested_by'], [], 'bad_shape');
    if (value['v'] !== 1) refuse('bad_version');
    const subject = value['subject'];
    if (!isPlainObject(subject)) refuse('bad_subject');
    exactKeys(subject, ['repo', 'repo_id', 'pr', 'head_sha'], [], 'bad_subject');
    return Object.freeze({
      v: 1,
      action,
      subject: Object.freeze({ ...target(subject, owner), head_sha: sha(subject['head_sha'], 'head_sha') }),
      requested_by: requestedBy(value['requested_by']),
    });
  }
  if (action === 'promote') {
    exactKeys(value, ['v', 'action', 'subject', 'evidence', 'requested_by'], [], 'bad_shape');
    if (value['v'] !== 1) refuse('bad_version');
    const subject = value['subject'];
    if (!isPlainObject(subject)) refuse('bad_subject');
    exactKeys(subject, ['repo', 'repo_id', 'pr', 'candidate_sha'], [], 'bad_subject');
    return Object.freeze({
      v: 1,
      action,
      subject: Object.freeze({ ...target(subject, owner), candidate_sha: sha(subject['candidate_sha'], 'candidate_sha') }),
      evidence: evidence(value['evidence']),
      requested_by: requestedBy(value['requested_by']),
    });
  }
  return refuse('bad_action');
}

/** Parse request bytes: bounded, fatal UTF-8, JSON, then validated. */
export function parseRequest(bytes: Uint8Array, owner: string): PromotionRequest {
  let parsed: unknown;
  try {
    parsed = decodeJson(bytes, REQUEST_LIMITS.maxBytes);
  } catch (error) {
    if (error instanceof DecodeError) refuse(error.reason);
    throw error;
  }
  return validateRequest(parsed, owner);
}
