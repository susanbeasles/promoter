// Every way the promoter says no. A refusal is a stable code in a plain object with status 403: it crosses
// the service binding as a value, never as a thrown error, and it never carries a stack trace or a secret.

export type RequestCode =
  | 'bad_request'
  | 'too_large'
  | 'bad_encoding'
  | 'bad_json'
  | 'bad_shape'
  | 'unknown_key'
  | 'bad_version'
  | 'bad_action'
  | 'bad_subject'
  | 'bad_repo'
  | 'bad_repo_id'
  | 'bad_pr'
  | 'bad_sha'
  | 'bad_evidence'
  | 'bad_requested_by';

export type ConfigCode = 'bad_config' | 'bad_key';

/** Codes from infra-root ADR-0001 section 1. */
export type PromotionCode =
  | 'not_open'
  | 'wrong_base'
  | 'head_moved'
  | 'repo_mismatch'
  | 'is_fork'
  | 'conflict'
  | 'nothing_to_promote'
  | 'no_shadow'
  | 'stale_base'
  | 'candidate_mismatch'
  | 'tree_mismatch'
  | 'not_fast_forward'
  | 'readback_mismatch'
  | 'api_error';

export type RefusalCode = RequestCode | ConfigCode | PromotionCode | 'internal';

export interface Refusal {
  readonly ok: false;
  readonly status: 403;
  readonly code: RefusalCode;
  readonly detail?: string;
  /** Set with `stale_base`: the promoter already re-prepared and the pipeline must run on this new candidate. */
  readonly candidate_sha?: string;
}

/** Detail strings are short, operator-facing and built only from constants, status codes and bounded vendor messages. */
export const MAX_DETAIL_LENGTH = 200;

export class RefusalError extends Error {
  readonly code: RefusalCode;
  readonly detail: string | undefined;
  constructor(code: RefusalCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RefusalError';
    this.code = code;
    this.detail = detail === undefined ? undefined : detail.slice(0, MAX_DETAIL_LENGTH);
  }
}

export function refuse(code: RefusalCode, detail?: string): never {
  throw new RefusalError(code, detail);
}

export function refusal(code: RefusalCode, detail?: string, candidateSha?: string): Refusal {
  const bounded = detail === undefined ? undefined : detail.slice(0, MAX_DETAIL_LENGTH);
  return {
    ok: false,
    status: 403,
    code,
    ...(bounded === undefined ? {} : { detail: bounded }),
    ...(candidateSha === undefined ? {} : { candidate_sha: candidateSha }),
  };
}

/** Anything thrown inside an operation becomes a refusal. Unknown errors become `internal` with only the error's name. */
export function toRefusal(error: unknown): Refusal {
  if (error instanceof RefusalError) return refusal(error.code, error.detail);
  const name = error instanceof Error ? error.name : typeof error;
  return refusal('internal', name);
}
