// Shadow integration and fast-forward-only promotion (infra-root ADR-0001 section 1). Every path ends in a
// plain value; nothing is thrown across the service binding. Every step is safe to repeat.

import * as gh from './github.ts';
import type { Api } from './github.ts';
import type { Fetcher } from './http.ts';
import type { Logger } from './log.ts';
import { tagMessage, tagName } from './provenance.ts';
import { refusal, refuse, toRefusal, type Refusal } from './refusal.ts';
import { parseEvidence, type Evidence, type PrepareRequest, type PromoteRequest } from './request.ts';
import { canonicalJson, type JsonValue } from './json.ts';
import type { ShadowRecord, ShadowStore } from './store.ts';

export const MAIN = 'main';
export const PROMOTER_VERSION = '0.2.0';
export const BODY_LIMIT = 4_000;
export const FOLLOWUPS = ['tag', 'comment', 'close', 'cleanup'] as const;
export type Followup = (typeof FOLLOWUPS)[number];

export const shadowBranch = (pr: number): string => `shadow/pr-${pr}`;

export interface PromotionDeps {
  readonly fetcher: Fetcher;
  readonly token: (repoId: number) => Promise<string>;
  readonly store: ShadowStore;
  readonly clock: () => number;
  readonly ownerId: number;
  readonly logger: Logger;
  /** Arm reconciliation (the Durable Object alarm) no later than `atMs`. */
  readonly schedule: (atMs: number) => Promise<void>;
}

/** How soon an in-flight `main` update is reconciled if the request that started it never returns. */
export const RECONCILE_AFTER_MS = 2 * 60_000;

export interface Prepared {
  readonly ok: true;
  readonly status: 200;
  readonly action: 'shadow.prepare';
  readonly shadow_ref: string;
  readonly candidate_sha: string;
  readonly base_sha: string;
  readonly tree_sha: string;
  readonly reused: boolean;
}

export interface Promoted {
  readonly ok: true;
  readonly status: 200;
  readonly action: 'promote';
  readonly main_sha: string;
  readonly tag: string;
  readonly already_promoted: boolean;
  /** Steps that failed after `main` moved; they are retried by the object's alarm and on every repeat. */
  readonly pending: readonly Followup[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Verify the pull request is an open, same-repository PR into `main` at the expected head. */
function checkPull(pull: gh.PullView, repoId: number, ownerId: number, headSha: string): void {
  if (pull.base.repoId !== repoId || pull.base.ownerId !== ownerId) refuse('repo_mismatch');
  if (pull.head.repoId !== repoId) refuse('is_fork');
  if (pull.state !== 'open') refuse('not_open');
  if (pull.base.ref !== MAIN) refuse('wrong_base', pull.base.ref.slice(0, 100));
  if (pull.head.sha !== headSha) refuse('head_moved');
}

export function candidateMessage(pull: gh.PullView, headSha: string, baseSha: string): string {
  const title = pull.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || `Pull request #${pull.number}`;
  const body = pull.body.length > BODY_LIMIT ? `${pull.body.slice(0, BODY_LIMIT)}\n\n[body truncated by promoter]` : pull.body;
  const coauthor = `${pull.author.id}+${pull.author.login}@users.noreply.github.com`;
  const trailers = [`Promoted-PR: #${pull.number}`, `Promoted-Head: ${headSha}`, `Shadow-Base: ${baseSha}`, `Co-authored-by: ${pull.author.login} <${coauthor}>`];
  return `${title} (#${pull.number})\n\n${body.trim().length > 0 ? `${body.trim()}\n\n` : ''}${trailers.join('\n')}\n`;
}

async function buildCandidate(api: Api, deps: PromotionDeps, pull: gh.PullView, repoId: number, headSha: string): Promise<ShadowRecord> {
  const base = await gh.getBranch(api, MAIN);
  if (base === undefined) refuse('api_error', 'main does not exist');
  const branch = shadowBranch(pull.number);
  const existing = await gh.getBranch(api, branch);
  if (existing === undefined) await gh.createBranch(api, branch, base);
  else await gh.moveBranch(api, branch, base, true);
  const merged = await gh.mergeInto(api, branch, headSha, `shadow merge of #${pull.number} at ${headSha.slice(0, 12)}`);
  if (merged === 'conflict') {
    await gh.deleteBranch(api, branch);
    refuse('conflict');
  }
  if (merged === 'nothing') {
    await gh.deleteBranch(api, branch);
    refuse('nothing_to_promote');
  }
  const candidate = await gh.createCommit(api, candidateMessage(pull, headSha, base), merged.tree, [base]);
  await gh.moveBranch(api, branch, candidate, true);
  const record: ShadowRecord = {
    repo_id: repoId,
    pr: pull.number,
    head_sha: headSha,
    base_sha: base,
    tree_sha: merged.tree,
    candidate_sha: candidate,
    state: 'prepared',
    prepared_at: iso(deps.clock()),
    promoted_at: null,
    tag: null,
    pending: [],
    evidence: null,
  };
  deps.store.put(record);
  return record;
}

export async function prepare(request: PrepareRequest, deps: PromotionDeps): Promise<Prepared | Refusal> {
  const { repo, repo_id: repoId, pr, head_sha: headSha } = request.subject;
  try {
    const api: Api = { fetcher: deps.fetcher, token: await deps.token(repoId), repo };
    const pull = await gh.getPull(api, pr);
    checkPull(pull, repoId, deps.ownerId, headSha);
    let recorded = deps.store.get(pr);
    if (recorded?.state === 'advancing') {
      // A promotion of this PR may be in flight: settle it before building anything new.
      const settled = await reconcile(api, deps, recorded);
      if (settled.kind !== 'reverted') refuse(settled.kind === 'promoted' ? 'already_promoted' : 'reconcile_conflict');
      recorded = deps.store.get(pr);
    }
    if (recorded?.state === 'promoted') refuse('already_promoted');
    if (recorded?.state === 'reconcile_conflict') refuse('reconcile_conflict');
    if (recorded !== undefined && recorded.state === 'prepared' && recorded.head_sha === headSha) {
      // Same head, same base, shadow branch still at the candidate: nothing to rebuild.
      const [main, shadow] = await Promise.all([gh.getBranch(api, MAIN), gh.getBranch(api, shadowBranch(pr))]);
      if (main === recorded.base_sha && shadow === recorded.candidate_sha) return prepared(recorded, true);
    }
    const record = await buildCandidate(api, deps, pull, repoId, headSha);
    deps.logger.log({ event: 'shadow.prepare', repo, pr, head_sha: headSha, base_sha: record.base_sha, candidate_sha: record.candidate_sha });
    return prepared(record, false);
  } catch (error) {
    const result = toRefusal(error);
    deps.logger.log({ event: 'shadow.prepare', repo, pr, outcome: 'refused', code: result.code, detail: result.detail });
    return result;
  }
}

function prepared(record: ShadowRecord, reused: boolean): Prepared {
  return {
    ok: true,
    status: 200,
    action: 'shadow.prepare',
    shadow_ref: `refs/heads/${shadowBranch(record.pr)}`,
    candidate_sha: record.candidate_sha,
    base_sha: record.base_sha,
    tree_sha: record.tree_sha,
    reused,
  };
}

/** Evidence persisted with the record. A promoted record always has it: it is written before `main` moves. */
function persistedEvidence(record: ShadowRecord): Evidence {
  if (record.evidence === null) refuse('api_error', 'record has no persisted evidence');
  return parseEvidence(JSON.parse(record.evidence) as unknown);
}

/** Run the steps that follow a successful fast-forward. Each is idempotent; failures stay pending. */
async function followups(api: Api, deps: PromotionDeps, record: ShadowRecord, prTitle: string): Promise<ShadowRecord> {
  let pending = [...record.pending] as Followup[];
  const tag = record.tag ?? tagName(record.pr, record.candidate_sha);
  const attempt = async (step: Followup, run: () => Promise<void>): Promise<void> => {
    if (!pending.includes(step)) return;
    try {
      await run();
      pending = pending.filter((p) => p !== step);
    } catch (error) {
      const r = toRefusal(error);
      deps.logger.log({ event: 'promote.followup', repo: api.repo, pr: record.pr, step, outcome: 'failed', code: r.code, detail: r.detail });
    }
  };
  const pointsAtCandidate = async (): Promise<boolean | undefined> => {
    const ref = await gh.getTagRef(api, tag);
    if (ref === undefined) return undefined;
    const target = ref.type === 'tag' ? await gh.getTagTarget(api, ref.sha) : ref.sha;
    if (target !== record.candidate_sha) refuse('api_error', `tag ${tag} points elsewhere`);
    return true;
  };
  await attempt('tag', async () => {
    if ((await pointsAtCandidate()) === true) return;
    const evidence = persistedEvidence(record);
    const { message } = await tagMessage({ repo: api.repo, record, prTitle, evidence, promotedAt: record.promoted_at ?? iso(deps.clock()), promoterVersion: PROMOTER_VERSION });
    const object = await gh.createAnnotatedTag(api, tag, message, record.candidate_sha);
    if ((await gh.createTagRef(api, tag, object)) === 'exists') await pointsAtCandidate();
  });
  const runId = record.evidence === null ? undefined : persistedEvidence(record).shadow_run_id;
  await attempt('comment', () =>
    gh.comment(
      api,
      record.pr,
      [
        `Promoted to \`main\` as ${record.candidate_sha} (fast-forward from ${record.base_sha.slice(0, 12)}).`,
        '',
        `Provenance tag: \`${tag}\``,
        `Pull request head: ${record.head_sha}`,
        ...(runId === undefined ? [] : [`Candidate pipeline run: https://github.com/${api.repo}/actions/runs/${runId}`]),
        '',
        'The squash commit on `main` is the exact tree that passed the pipeline on the shadow branch, so this pull request is closed rather than merged.',
      ].join('\n'),
    ),
  );
  await attempt('close', async () => {
    const pull = await gh.getPull(api, record.pr);
    if (pull.state === 'open') await gh.closePull(api, record.pr);
  });
  await attempt('cleanup', () => gh.deleteBranch(api, shadowBranch(record.pr)));
  const updated: ShadowRecord = { ...record, tag, pending };
  deps.store.put(updated);
  return updated;
}

type Settled = { readonly kind: 'promoted'; readonly record: ShadowRecord } | { readonly kind: 'reverted' } | { readonly kind: 'conflict'; readonly main: string };

/**
 * Settle an `advancing` record from what `main` actually is (ADR-0002 section 5). Never moves `main` and never
 * uses any evidence but the copy persisted before the update.
 */
async function reconcile(api: Api, deps: PromotionDeps, record: ShadowRecord): Promise<Settled> {
  const main = await gh.getBranch(api, MAIN);
  if (main === record.candidate_sha) {
    const promoted: ShadowRecord = { ...record, state: 'promoted', promoted_at: record.promoted_at ?? iso(deps.clock()), tag: tagName(record.pr, record.candidate_sha), pending: [...FOLLOWUPS] };
    deps.store.put(promoted);
    const pull = await gh.getPull(api, record.pr);
    const done = await followups(api, deps, promoted, pull.title);
    deps.logger.log({ event: 'promote.reconcile', repo: api.repo, pr: record.pr, candidate_sha: record.candidate_sha, outcome: 'completed', pending: done.pending.join(',') });
    return { kind: 'promoted', record: done };
  }
  if (main === record.base_sha) {
    deps.store.put({ ...record, state: 'prepared', evidence: null });
    deps.logger.log({ event: 'promote.reconcile', repo: api.repo, pr: record.pr, candidate_sha: record.candidate_sha, outcome: 'reverted' });
    return { kind: 'reverted' };
  }
  deps.store.put({ ...record, state: 'reconcile_conflict' });
  deps.logger.log({ event: 'promote.reconcile', repo: api.repo, pr: record.pr, candidate_sha: record.candidate_sha, outcome: 'conflict', main_sha: main ?? 'none', severity: 'critical' });
  return { kind: 'conflict', main: main ?? 'none' };
}

function promotedResult(record: ShadowRecord, already: boolean): Promoted {
  return { ok: true, status: 200, action: 'promote', main_sha: record.candidate_sha, tag: record.tag ?? tagName(record.pr, record.candidate_sha), already_promoted: already, pending: record.pending as Followup[] };
}

export async function promote(request: PromoteRequest, deps: PromotionDeps, depth = 0): Promise<Promoted | Refusal> {
  const { repo, repo_id: repoId, pr, candidate_sha: candidate } = request.subject;
  const log = (fields: Record<string, string | number | boolean | undefined>): void => deps.logger.log({ event: 'promote', repo, pr, candidate_sha: candidate, ...fields });
  try {
    const record = deps.store.get(pr);
    if (record === undefined) refuse('no_shadow');
    if (record.candidate_sha !== candidate) refuse('candidate_mismatch');
    if (record.state === 'reconcile_conflict') refuse('reconcile_conflict');
    const api: Api = { fetcher: deps.fetcher, token: await deps.token(repoId), repo };

    if (record.state === 'advancing') {
      const settled = await reconcile(api, deps, record);
      if (settled.kind === 'promoted') return promotedResult(settled.record, true);
      if (settled.kind === 'conflict') refuse('reconcile_conflict', `main is at ${settled.main.slice(0, 12)}`);
      if (depth > 0) refuse('api_error', 'reconciliation did not settle');
      return promote(request, deps, depth + 1);
    }
    if (record.state === 'promoted') {
      const pull = await gh.getPull(api, pr);
      const done = await followups(api, deps, record, pull.title);
      log({ outcome: 'already_promoted', pending: done.pending.join(',') });
      return promotedResult(done, true);
    }

    const main = await gh.getBranch(api, MAIN);
    if (main === undefined) refuse('api_error', 'main does not exist');
    if (main === candidate) {
      // Without a recorded intent the promoter did not move main here: never adopt it.
      deps.store.put({ ...record, state: 'reconcile_conflict' });
      log({ outcome: 'reconcile_conflict', severity: 'critical' });
      refuse('reconcile_conflict', 'main is at the candidate without a recorded intent');
    }
    const pull = await gh.getPull(api, pr);
    checkPull(pull, repoId, deps.ownerId, record.head_sha);
    const commit = await gh.getCommit(api, candidate);
    if (commit === undefined) refuse('candidate_mismatch', 'candidate commit not found');
    if (commit.tree !== record.tree_sha) refuse('tree_mismatch');
    if (commit.parents.length !== 1 || commit.parents[0] !== record.base_sha) refuse('candidate_mismatch', 'candidate parents changed');

    if (main !== record.base_sha) {
      const rebuilt = await buildCandidate(api, deps, pull, repoId, record.head_sha);
      log({ outcome: 'stale_base', new_candidate_sha: rebuilt.candidate_sha });
      return refusal('stale_base', `main is at ${main.slice(0, 12)}`, rebuilt.candidate_sha);
    }

    // Intent first: evidence and state are durable before main can move, and reconciliation is armed.
    const evidence = canonicalJson(request.evidence as unknown as JsonValue);
    const advancing: ShadowRecord = { ...record, state: 'advancing', evidence, promoted_at: iso(deps.clock()) };
    deps.store.put(advancing);
    await deps.schedule(deps.clock() + RECONCILE_AFTER_MS);

    // Final check of the expected head immediately before the fast-forward-only update.
    const finalMain = await gh.getBranch(api, MAIN);
    if (finalMain !== record.base_sha) {
      deps.store.put({ ...record, state: 'prepared', evidence: null });
      log({ outcome: 'stale_base_at_update' });
      return refusal('stale_base', `main moved to ${finalMain?.slice(0, 12) ?? 'nothing'} before the update`);
    }
    if ((await gh.moveBranch(api, MAIN, candidate, false)) === 'not_fast_forward') {
      deps.store.put({ ...record, state: 'prepared', evidence: null });
      log({ outcome: 'not_fast_forward' });
      return refusal('not_fast_forward');
    }
    const readback = await gh.getBranch(api, MAIN);
    if (readback !== candidate) {
      // Leave the intent in place: reconciliation decides from main's state, never from this response.
      log({ outcome: 'readback_mismatch' });
      return refusal('readback_mismatch', `main reads ${readback?.slice(0, 12) ?? 'nothing'}`);
    }
    const promoted: ShadowRecord = { ...advancing, state: 'promoted', tag: tagName(pr, candidate), pending: [...FOLLOWUPS] };
    deps.store.put(promoted);
    const done = await followups(api, deps, promoted, pull.title);
    log({ outcome: 'promoted', tag: done.tag ?? undefined, pending: done.pending.join(',') });
    return promotedResult(done, false);
  } catch (error) {
    const result = toRefusal(error);
    log({ outcome: 'refused', code: result.code, detail: result.detail });
    return result;
  }
}

/** Alarm path: settle in-flight updates, then retry follow-ups. Returns the number of open items. */
export async function reconcileAll(repo: string, deps: PromotionDeps): Promise<number> {
  let open = 0;
  for (const record of deps.store.advancing()) {
    try {
      const api: Api = { fetcher: deps.fetcher, token: await deps.token(record.repo_id), repo };
      const settled = await reconcile(api, deps, record);
      if (settled.kind === 'promoted') open += settled.record.pending.length;
    } catch {
      open += 1;
    }
  }
  for (const record of deps.store.pendingFollowups()) {
    try {
      const api: Api = { fetcher: deps.fetcher, token: await deps.token(record.repo_id), repo };
      const pull = await gh.getPull(api, record.pr);
      open += (await followups(api, deps, record, pull.title)).pending.length;
    } catch {
      open += record.pending.length;
    }
  }
  return open;
}
