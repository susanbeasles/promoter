import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../src/log.ts';
import type { PromotionDeps } from '../src/promotion.ts';
import type { PrepareRequest, PromoteRequest } from '../src/request.ts';
import { SqlShadowStore, type SqlLike, type SqlValue } from '../src/store.ts';
import { FakeGitHub, OWNER_ID, REPO, REPO_ID } from './fake-github.ts';

export const TOKEN = 'ghs_fake_installation_token_for_tests_only';

/** `node:sqlite` shaped like the Durable Object SqlStorage.exec(). */
export function sqlite(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      const isRead = /^\s*SELECT/i.test(query);
      if (bindings.length === 0 && !isRead) {
        db.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = db.prepare(query);
      if (isRead) return { toArray: () => statement.all(...(bindings as (string | number | null)[])) as unknown as T[] };
      statement.run(...(bindings as (string | number | null)[]));
      return { toArray: () => [] as T[] };
    },
  };
}

export interface Harness {
  gh: FakeGitHub;
  deps: PromotionDeps;
  logs: Record<string, unknown>[];
  main: string;
  head: string;
}

export function harness(): Harness {
  const { gh, main, head } = FakeGitHub.seeded();
  const logs: Record<string, unknown>[] = [];
  const logger: Logger = { log: (event) => logs.push(JSON.parse(JSON.stringify(event))), register: () => undefined };
  let now = Date.parse('2026-10-15T12:00:00Z');
  const deps: PromotionDeps = {
    fetcher: gh.fetcher,
    token: async (repoId) => {
      if (repoId !== REPO_ID) throw new Error('token for wrong repo');
      return TOKEN;
    },
    store: new SqlShadowStore(sqlite(), REPO_ID),
    clock: () => (now += 1_000),
    ownerId: OWNER_ID,
    logger,
  };
  return { gh, deps, logs, main, head };
}

export const prepareRequest = (headSha: string, pr = 7): PrepareRequest => ({
  v: 1,
  action: 'shadow.prepare',
  subject: { repo: REPO, repo_id: REPO_ID, pr, head_sha: headSha },
  requested_by: { sub: 'repo:susanbeasles/deployer:pull_request', run_id: '101' },
});

export const promoteRequest = (candidateSha: string, pr = 7): PromoteRequest => ({
  v: 1,
  action: 'promote',
  subject: { repo: REPO, repo_id: REPO_ID, pr, candidate_sha: candidateSha },
  evidence: {
    checks: [
      { name: 'pipeline / lint-test', id: 11, conclusion: 'success', completed_at: '2026-10-15T11:58:00Z' },
      { name: 'pipeline / security', id: 12, conclusion: 'success', completed_at: '2026-10-15T11:59:00Z' },
    ],
    attestations: [{ digest: `sha256:${'a'.repeat(64)}`, bundle_url: 'https://api.github.com/repos/susanbeasles/deployer/attestations/1' }],
    shadow_run_id: 555,
    decision_id: 'dec_0123456789abcdef',
  },
  requested_by: { sub: 'repo:susanbeasles/deployer:ref:refs/heads/shadow/pr-7', run_id: '555' },
});
