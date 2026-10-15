// Shadow integration and fast-forward-only promotion (infra-root ADR-0001 section 1). Every path ends in a
// plain value; nothing is thrown across the service binding. Every step is safe to repeat.

import * as gh from './github.ts';
import type { Api } from './github.ts';
import type { Fetcher } from './http.ts';
import type { Logger } from './log.ts';
import { tagMessage, tagName } from './provenance.ts';
import { refusal, refuse, toRefusal, type Refusal } from './refusal.ts';
import type { PrepareRequest, PromoteRequest } from './request.ts';
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
}

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
    const recorded = deps.store.get(pr);
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

/** Run the steps that follow a successful fast-forward. Each is idempotent; failures stay pending. */
async function followups(api: Api, deps: PromotionDeps, record: ShadowRecord, request: PromoteRequest | undefined, prTitle: string): Promise<ShadowRecord> {
  let pending = [...record.pending] as Followup[];
  let tag = record.tag ?? tagName(record.pr, record.candidate_sha);
  const done = (step: Followup): void => {
    pending = pending.filter((p) => p !== step);
  };
  const attempt = async (step: Followup, run: () => Promise<void>): Promise<void> => {
    if (!pending.includes(step)) return;
    try {
      await run();
      done(step);
    } catch (error) {
      const r = toRefusal(error);
      deps.logger.log({ event: 'promote.followup', repo: api.repo, pr: record.pr, step, outcome: 'failed', code: r.code, detail: r.detail });
    }
  };
  await attempt('tag', async () => {
    const existing = await gh.getTagRef(api, tag);
    if (existing !== undefined) {
      const target = existing.type === 'tag' ? await gh.getTagTarget(api, existing.sha) : existing.sha;
      if (target !== record.candidate_sha) refuse('api_error', `tag ${tag} points elsewhere`);
      return;
    }
    if (request === undefined) refuse('api_error', 'tag evidence unavailable; repeat the promote request');
    const { message } = await tagMessage({
      repo: api.repo,
      record,
      prTitle,
      evidence: request.evidence,
      promotedAt: record.promoted_at ?? iso(deps.clock()),
      promoterVersion: PROMOTER_VERSION,
    });
    const object = await gh.createAnnotatedTag(api, tag, message, record.candidate_sha);
    if ((await gh.createTagRef(api, tag, object)) === 'exists') {
      const again = await gh.getTagRef(api, tag);
      const target = again?.type === 'tag' ? await gh.getTagTarget(api, again.sha) : again?.sha;
      if (target !== record.candidate_sha) refuse('api_error', `tag ${tag} points elsewhere`);
    }
  });
  await attempt('comment', () =>
    gh.comment(
      api,
      record.pr,
      [
        `Promoted to \`main\` as ${record.candidate_sha} (fast-forward from ${record.base_sha.slice(0, 12)}).`,
        '',
        `Provenance tag: \`${tag}\``,
        `Pull request head: ${record.head_sha}`,
        request === undefined ? '' : `Candidate pipeline run: https://github.com/${api.repo}/actions/runs/${request.evidence.shadow_run_id}`,
        '',
        'The squash commit on `main` is the exact tree that passed the pipeline on the shadow branch, so this pull request is closed rather than merged.',
      ]
        .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
        .join('\n'),
    ),
  );
  await attempt('close', async () => {
    const pull = await gh.getPull(api, record.pr);
    if (pull.state === 'open') await gh.closePull(api, record.pr);
  });
  await attempt('cleanup', () => gh.deleteBranch(api, shadowBranch(record.pr)));
  tag = record.tag ?? tag;
  const updated: ShadowRecord = { ...record, tag, pending };
  deps.store.put(updated);
  return updated;
}

export async function promote(request: PromoteRequest, deps: PromotionDeps): Promise<Promoted | Refusal> {
  const { repo, repo_id: repoId, pr, candidate_sha: candidate } = request.subject;
  const log = (fields: Record<string, string | number | boolean | undefined>): void => deps.logger.log({ event: 'promote', repo, pr, candidate_sha: candidate, ...fields });
  try {
    const record = deps.store.get(pr);
    if (record === undefined) refuse('no_shadow');
    if (record.candidate_sha !== candidate) refuse('candidate_mismatch');
    const api: Api = { fetcher: deps.fetcher, token: await deps.token(repoId), repo };
    const main = await gh.getBranch(api, MAIN);
    if (main === undefined) refuse('api_error', 'main does not exist');

    if (record.state === 'promoted' || main === candidate) {
      // Repeat after success: finish any follow-ups and report the existing promotion.
      const base: ShadowRecord = record.state === 'promoted' ? record : { ...record, state: 'promoted', promoted_at: iso(deps.clock()), tag: tagName(pr, candidate), pending: [...FOLLOWUPS] };
      const pull = await gh.getPull(api, pr);
      const done = await followups(api, deps, base, request, pull.title);
      log({ outcome: 'already_promoted', pending: done.pending.join(',') });
      return { ok: true, status: 200, action: 'promote', main_sha: candidate, tag: done.tag ?? tagName(pr, candidate), already_promoted: true, pending: done.pending as Followup[] };
    }

    const pull = await gh.getPull(api, pr);
    checkPull(pull, repoId, deps.ownerId, record.head_sha);
    const commit = await gh.getCommit(api, candidate);
    if (commit === undefined) refuse('candidate_mismatch', 'candidate commit not found');
    if (commit.tree !== record.tree_sha) refuse('tree_mismatch');
    if (commit.parents.length !== 1 || commit.parents[0] !== record.base_sha) refuse('candidate_mismatch', 'candidate parents changed');

    if (main !== record.base_sha) {
      // `main` moved since the candidate was built. Rebuild on the new tip; the pipeline must run again.
      const rebuilt = await buildCandidate(api, deps, pull, repoId, record.head_sha);
      log({ outcome: 'stale_base', new_candidate_sha: rebuilt.candidate_sha });
      return refusal('stale_base', `main is at ${main.slice(0, 12)}`, rebuilt.candidate_sha);
    }

    if ((await gh.moveBranch(api, MAIN, candidate, false)) === 'not_fast_forward') {
      log({ outcome: 'not_fast_forward' });
      return refusal('not_fast_forward');
    }
    const readback = await gh.getBranch(api, MAIN);
    if (readback !== candidate) {
      log({ outcome: 'readback_mismatch' });
      return refusal('readback_mismatch', `main reads ${readback?.slice(0, 12) ?? 'nothing'}`);
    }

    const promoted: ShadowRecord = { ...record, state: 'promoted', promoted_at: iso(deps.clock()), tag: tagName(pr, candidate), pending: [...FOLLOWUPS] };
    deps.store.put(promoted);
    const done = await followups(api, deps, promoted, request, pull.title);
    log({ outcome: 'promoted', tag: done.tag ?? undefined, pending: done.pending.join(',') });
    return { ok: true, status: 200, action: 'promote', main_sha: candidate, tag: done.tag ?? tagName(pr, candidate), already_promoted: false, pending: done.pending as Followup[] };
  } catch (error) {
    const result = toRefusal(error);
    log({ outcome: 'refused', code: result.code, detail: result.detail });
    return result;
  }
}

/**
 * Alarm path: retry follow-ups for promoted candidates. The tag needs the authorizer's evidence; when the
 * evidence is gone (the original call ended), a missing tag stays pending until the promote request is repeated.
 */
export async function retryFollowups(repo: string, deps: PromotionDeps): Promise<number> {
  let remaining = 0;
  for (const record of deps.store.pendingFollowups()) {
    try {
      const api: Api = { fetcher: deps.fetcher, token: await deps.token(record.repo_id), repo };
      const pull = await gh.getPull(api, record.pr);
      const done = await followups(api, deps, record, undefined, pull.title);
      remaining += done.pending.length;
    } catch {
      remaining += record.pending.length;
    }
  }
  return remaining;
}
