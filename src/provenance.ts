// The provenance tag: `promote/pr-<n>-<first 12 hex of the candidate>`, an annotated tag whose message is a
// one-line summary, a blank line, canonical JSON `promotion-provenance/v1`, a blank line and its sha256.

import { canonicalJson, type JsonObject } from './json.ts';
import type { Evidence } from './request.ts';
import type { ShadowRecord } from './store.ts';

export const PROVENANCE_SCHEMA = 'promotion-provenance/v1';

export function tagName(pr: number, candidateSha: string): string {
  return `promote/pr-${pr}-${candidateSha.slice(0, 12)}`;
}

export interface ProvenanceInput {
  readonly repo: string;
  readonly record: ShadowRecord;
  readonly prTitle: string;
  readonly evidence: Evidence;
  readonly promotedAt: string;
  readonly promoterVersion: string;
}

export function provenance(input: ProvenanceInput): JsonObject {
  const { record, evidence } = input;
  return {
    schema: PROVENANCE_SCHEMA,
    repo: input.repo,
    repo_id: record.repo_id,
    pr: record.pr,
    pr_title: input.prTitle.slice(0, 200),
    head_sha: record.head_sha,
    base_sha: record.base_sha,
    candidate_sha: record.candidate_sha,
    tree_sha: record.tree_sha,
    checks: evidence.checks.map((c) => ({ name: c.name, id: c.id, conclusion: c.conclusion, completed_at: c.completed_at })),
    attestations: evidence.attestations.map((a) => ({ digest: a.digest, bundle_url: a.bundle_url })),
    shadow_run_id: evidence.shadow_run_id,
    authorizer_decision: evidence.decision_id,
    promoted_at: input.promotedAt,
    promoter_version: input.promoterVersion,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function tagMessage(input: ProvenanceInput): Promise<{ readonly message: string; readonly sha256: string }> {
  const json = canonicalJson(provenance(input));
  const digest = await sha256Hex(json);
  const summary = `Promote PR #${input.record.pr} to main as ${input.record.candidate_sha.slice(0, 12)}`;
  return { message: `${summary}\n\n${json}\n\nsha256:${digest}\n`, sha256: digest };
}

/** Parse a provenance tag message back into its JSON and check its digest. Used by tests and by the caretaker. */
export async function readTagMessage(message: string): Promise<JsonObject | undefined> {
  const parts = message.split('\n\n');
  if (parts.length < 3) return undefined;
  const json = parts[1] ?? '';
  const trailer = (parts[2] ?? '').trim();
  if (trailer !== `sha256:${await sha256Hex(json)}`) return undefined;
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
}
