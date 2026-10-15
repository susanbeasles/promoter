// The promoter's own record of each shadow candidate, kept in the Durable Object's SQLite storage (one object
// per repository). `promote` refuses any candidate that does not match the record `prepare` wrote.

/** `advancing`: intent recorded, `main` may or may not have moved; only reconciliation leaves this state. */
export type ShadowState = 'prepared' | 'advancing' | 'promoted' | 'reconcile_conflict';
export const SHADOW_STATES: readonly ShadowState[] = ['prepared', 'advancing', 'promoted', 'reconcile_conflict'];

export interface ShadowRecord {
  readonly repo_id: number;
  readonly pr: number;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly tree_sha: string;
  readonly candidate_sha: string;
  readonly state: ShadowState;
  readonly prepared_at: string;
  readonly promoted_at: string | null;
  readonly tag: string | null;
  /** Follow-up steps after `main` moved that still have to succeed: `tag`, `comment`, `close`, `cleanup`. */
  readonly pending: readonly string[];
  /** The authorizer's evidence (canonical JSON), persisted before `main` moves; the tag is built only from it. */
  readonly evidence: string | null;
}

export interface ShadowStore {
  get(pr: number): ShadowRecord | undefined;
  put(record: ShadowRecord): void;
  pendingFollowups(): readonly ShadowRecord[];
  /** Records whose `main` update may be in flight and must be reconciled. */
  advancing(): readonly ShadowRecord[];
}

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export const SHADOW_SCHEMA = `CREATE TABLE IF NOT EXISTS shadow (
  pr INTEGER PRIMARY KEY CHECK (pr > 0),
  repo_id INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'advancing', 'promoted', 'reconcile_conflict')),
  prepared_at TEXT NOT NULL,
  promoted_at TEXT,
  tag TEXT,
  pending TEXT NOT NULL DEFAULT '[]',
  evidence TEXT
)`;

interface Row extends Record<string, SqlValue> {
  pr: number;
  repo_id: number;
  head_sha: string;
  base_sha: string;
  tree_sha: string;
  candidate_sha: string;
  state: string;
  prepared_at: string;
  promoted_at: string | null;
  tag: string | null;
  pending: string;
  evidence: string | null;
}

function toRecord(row: Row): ShadowRecord {
  if (!SHADOW_STATES.includes(row.state as ShadowState)) throw new Error('corrupt shadow row');
  const pending: unknown = JSON.parse(row.pending);
  if (!Array.isArray(pending) || !pending.every((p) => typeof p === 'string')) throw new Error('corrupt shadow row');
  return { ...row, state: row.state as ShadowState, pending };
}

export class SqlShadowStore implements ShadowStore {
  readonly #sql: SqlLike;
  readonly #repoId: number;
  constructor(sql: SqlLike, repoId: number) {
    this.#sql = sql;
    this.#repoId = repoId;
    this.#sql.exec(SHADOW_SCHEMA);
  }
  get(pr: number): ShadowRecord | undefined {
    const row = this.#sql.exec<Row>('SELECT * FROM shadow WHERE pr = ?', pr).toArray()[0];
    if (row === undefined) return undefined;
    if (row.repo_id !== this.#repoId) throw new Error('shadow store belongs to another repository');
    return toRecord(row);
  }
  put(record: ShadowRecord): void {
    if (record.repo_id !== this.#repoId) throw new Error('shadow store belongs to another repository');
    this.#sql.exec(
      `INSERT INTO shadow (pr, repo_id, head_sha, base_sha, tree_sha, candidate_sha, state, prepared_at, promoted_at, tag, pending, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr) DO UPDATE SET head_sha = excluded.head_sha, base_sha = excluded.base_sha, tree_sha = excluded.tree_sha,
         candidate_sha = excluded.candidate_sha, state = excluded.state, prepared_at = excluded.prepared_at,
         promoted_at = excluded.promoted_at, tag = excluded.tag, pending = excluded.pending, evidence = excluded.evidence`,
      record.pr,
      record.repo_id,
      record.head_sha,
      record.base_sha,
      record.tree_sha,
      record.candidate_sha,
      record.state,
      record.prepared_at,
      record.promoted_at,
      record.tag,
      JSON.stringify(record.pending),
      record.evidence,
    );
  }
  advancing(): readonly ShadowRecord[] {
    return this.#sql.exec<Row>("SELECT * FROM shadow WHERE state = 'advancing'").toArray().map(toRecord);
  }
  pendingFollowups(): readonly ShadowRecord[] {
    return this.#sql.exec<Row>("SELECT * FROM shadow WHERE state = 'promoted' AND pending != '[]'").toArray().map(toRecord);
  }
}
