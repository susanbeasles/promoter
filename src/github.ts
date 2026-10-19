// Typed wrappers over the GitHub REST calls promotion needs. Each reads only the fields it uses, fatally, and
// turns any unexpected status into a refusal. Paths are built from validated parts only.

import { callGitHub, describeStatus } from './github-api.ts';
import type { Fetcher } from './http.ts';
import { isPlainObject, isPositiveInteger, type JsonValue } from './json.ts';
import { refuse } from './refusal.ts';
import { SHA } from './request.ts';

export interface Api {
  readonly fetcher: Fetcher;
  readonly token: string;
  /** `owner/name`, already validated. */
  readonly repo: string;
}

export interface PullView {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly title: string;
  readonly body: string;
  readonly author: { readonly login: string; readonly id: number };
  readonly head: { readonly sha: string; readonly repoId: number | null };
  readonly base: { readonly ref: string; readonly repoId: number; readonly ownerId: number };
}

export interface CommitView {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export interface TagRefView {
  readonly type: 'tag' | 'commit';
  readonly sha: string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const TAG = /^[A-Za-z0-9._/-]{1,200}$/;

function shape(label: string, field: string): never {
  return refuse('api_error', `${label}: shape ${field}`);
}

function shaField(body: Record<string, unknown>, field: string, label: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !SHA.test(value)) shape(label, field);
  return value;
}

function object(value: unknown, label: string, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) shape(label, field);
  return value;
}

function call(api: Api, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: JsonValue) {
  return callGitHub(api.fetcher, { method, path: `/repos/${api.repo}${path}`, bearer: api.token, ...(body === undefined ? {} : { body }) });
}

export function branchPath(branch: string): string {
  if (!BRANCH.test(branch) || branch.includes('..')) throw new Error('invalid branch');
  return `heads/${branch}`;
}

export function tagPath(tag: string): string {
  if (!TAG.test(tag) || tag.includes('..')) throw new Error('invalid tag');
  return `tags/${tag}`;
}

export async function getPull(api: Api, pr: number): Promise<PullView> {
  const res = await call(api, 'GET', `/pulls/${pr}`);
  if (res.status === 404) refuse('not_open', 'pull request not found');
  if (res.status !== 200) refuse('api_error', describeStatus('pull', res.status, res.body));
  const b = object(res.body, 'pull', 'root');
  const number = b['number'];
  if (!isPositiveInteger(number) || number !== pr) shape('pull', 'number');
  const state = b['state'];
  if (state !== 'open' && state !== 'closed') shape('pull', 'state');
  const merged = b['merged'];
  if (typeof merged !== 'boolean') shape('pull', 'merged');
  const title = b['title'];
  if (typeof title !== 'string') shape('pull', 'title');
  const body = b['body'];
  if (body !== null && typeof body !== 'string') shape('pull', 'body');
  const user = object(b['user'], 'pull', 'user');
  const login = user['login'];
  const userId = user['id'];
  if (typeof login !== 'string' || !LOGIN.test(login.replace(/\[bot\]$/, '')) || !isPositiveInteger(userId)) shape('pull', 'user');
  const head = object(b['head'], 'pull', 'head');
  const headRepo = head['repo'];
  const headRepoId = headRepo === null ? null : object(headRepo, 'pull', 'head.repo')['id'];
  if (headRepoId !== null && !isPositiveInteger(headRepoId)) shape('pull', 'head.repo.id');
  const base = object(b['base'], 'pull', 'base');
  const baseRef = base['ref'];
  if (typeof baseRef !== 'string') shape('pull', 'base.ref');
  const baseRepo = object(base['repo'], 'pull', 'base.repo');
  const baseRepoId = baseRepo['id'];
  const baseOwnerId = object(baseRepo['owner'], 'pull', 'base.repo.owner')['id'];
  if (!isPositiveInteger(baseRepoId) || !isPositiveInteger(baseOwnerId)) shape('pull', 'base.repo');
  return {
    number,
    state,
    merged,
    title,
    body: body ?? '',
    author: { login, id: userId },
    head: { sha: shaField(head, 'sha', 'pull'), repoId: headRepoId as number | null },
    base: { ref: baseRef, repoId: baseRepoId, ownerId: baseOwnerId },
  };
}

/** The commit a branch points at, or `undefined` when the branch does not exist. */
export async function getBranch(api: Api, branch: string): Promise<string | undefined> {
  const res = await call(api, 'GET', `/git/ref/${branchPath(branch)}`);
  if (res.status === 404) return undefined;
  if (res.status !== 200) refuse('api_error', describeStatus('ref', res.status, res.body));
  const b = object(res.body, 'ref', 'root');
  const target = object(b['object'], 'ref', 'object');
  if (target['type'] !== 'commit') shape('ref', 'object.type');
  return shaField(target, 'sha', 'ref');
}

export async function createBranch(api: Api, branch: string, sha: string): Promise<void> {
  const res = await call(api, 'POST', '/git/refs', { ref: `refs/${branchPath(branch)}`, sha });
  if (res.status !== 201) refuse('api_error', describeStatus('create ref', res.status, res.body));
}

/** Move a branch. `force: false` is a fast-forward-only update: GitHub answers 422 when it is not one. */
export async function moveBranch(api: Api, branch: string, sha: string, force: boolean): Promise<'moved' | 'not_fast_forward'> {
  const res = await call(api, 'PATCH', `/git/refs/${branchPath(branch)}`, { sha, force });
  if (res.status === 200) return 'moved';
  if (res.status === 422 && !force) return 'not_fast_forward';
  return refuse('api_error', describeStatus('update ref', res.status, res.body));
}

export async function deleteBranch(api: Api, branch: string): Promise<void> {
  const res = await call(api, 'DELETE', `/git/refs/${branchPath(branch)}`);
  if (res.status !== 204 && res.status !== 404 && res.status !== 422) refuse('api_error', describeStatus('delete ref', res.status, res.body));
}

/** Merge `head` into `base` branch server-side. Returns the merge commit, `nothing` (204) or `conflict` (409). */
export async function mergeInto(api: Api, base: string, head: string, message: string): Promise<{ readonly sha: string; readonly tree: string } | 'nothing' | 'conflict'> {
  branchPath(base);
  const res = await call(api, 'POST', '/merges', { base, head, commit_message: message });
  if (res.status === 204) return 'nothing';
  if (res.status === 409) return 'conflict';
  if (res.status !== 201) refuse('api_error', describeStatus('merge', res.status, res.body));
  const b = object(res.body, 'merge', 'root');
  const commit = object(b['commit'], 'merge', 'commit');
  const tree = object(commit['tree'], 'merge', 'commit.tree');
  return { sha: shaField(b, 'sha', 'merge'), tree: shaField(tree, 'sha', 'merge') };
}

export async function createCommit(api: Api, message: string, tree: string, parents: readonly string[]): Promise<string> {
  const res = await call(api, 'POST', '/git/commits', { message, tree, parents: [...parents] });
  if (res.status !== 201) refuse('api_error', describeStatus('create commit', res.status, res.body));
  return shaField(object(res.body, 'commit', 'root'), 'sha', 'commit');
}

export async function getCommit(api: Api, sha: string): Promise<CommitView | undefined> {
  const res = await call(api, 'GET', `/git/commits/${sha}`);
  if (res.status === 404) return undefined;
  if (res.status !== 200) refuse('api_error', describeStatus('commit', res.status, res.body));
  const b = object(res.body, 'commit', 'root');
  const tree = object(b['tree'], 'commit', 'tree');
  const parents = b['parents'];
  if (!Array.isArray(parents)) shape('commit', 'parents');
  const message = b['message'];
  if (typeof message !== 'string') shape('commit', 'message');
  return {
    sha: shaField(b, 'sha', 'commit'),
    tree: shaField(tree, 'sha', 'commit'),
    parents: parents.map((p) => shaField(object(p, 'commit', 'parent'), 'sha', 'commit')),
    message,
  };
}

/** Where a tag ref points: an annotated tag object or a commit. `undefined` when the tag does not exist. */
export async function getTagRef(api: Api, tag: string): Promise<TagRefView | undefined> {
  const res = await call(api, 'GET', `/git/ref/${tagPath(tag)}`);
  if (res.status === 404) return undefined;
  if (res.status !== 200) refuse('api_error', describeStatus('tag ref', res.status, res.body));
  const target = object(object(res.body, 'tag ref', 'root')['object'], 'tag ref', 'object');
  const type = target['type'];
  if (type !== 'tag' && type !== 'commit') shape('tag ref', 'object.type');
  return { type, sha: shaField(target, 'sha', 'tag ref') };
}

/** Read an annotated tag's immutable identity, internal name, message and direct commit target. */
export async function getAnnotatedTag(api: Api, tagObjectSha: string): Promise<{ readonly sha: string; readonly tag: string; readonly message: string; readonly target: string }> {
  const res = await call(api, 'GET', `/git/tags/${tagObjectSha}`);
  if (res.status !== 200) refuse('api_error', describeStatus('tag object', res.status, res.body));
  const b = object(res.body, 'tag object', 'root');
  const target = object(b['object'], 'tag object', 'object');
  if (target['type'] !== 'commit') shape('tag object', 'object.type');
  const tag = b['tag'];
  const message = b['message'];
  if (typeof tag !== 'string' || typeof message !== 'string') shape('tag object', 'tag/message');
  return { sha: shaField(b, 'sha', 'tag object'), tag, message, target: shaField(target, 'sha', 'tag object') };
}

export async function createAnnotatedTag(api: Api, tag: string, message: string, commit: string): Promise<string> {
  tagPath(tag);
  const res = await call(api, 'POST', '/git/tags', { tag, message, object: commit, type: 'commit' });
  if (res.status !== 201) refuse('api_error', describeStatus('create tag', res.status, res.body));
  return shaField(object(res.body, 'tag', 'root'), 'sha', 'tag');
}

/** Create `refs/tags/<tag>`. Returns `exists` when the ref is already there (immutable tags never move). */
export async function createTagRef(api: Api, tag: string, tagObjectSha: string): Promise<'created' | 'exists'> {
  const res = await call(api, 'POST', '/git/refs', { ref: `refs/${tagPath(tag)}`, sha: tagObjectSha });
  if (res.status === 201) return 'created';
  if (res.status === 422) return 'exists';
  return refuse('api_error', describeStatus('create tag ref', res.status, res.body));
}

export async function comment(api: Api, pr: number, body: string): Promise<void> {
  const res = await call(api, 'POST', `/issues/${pr}/comments`, { body });
  if (res.status !== 201) refuse('api_error', describeStatus('comment', res.status, res.body));
}

export async function closePull(api: Api, pr: number): Promise<void> {
  const res = await call(api, 'PATCH', `/pulls/${pr}`, { state: 'closed' });
  if (res.status !== 200) refuse('api_error', describeStatus('close pull', res.status, res.body));
}
