// An in-memory GitHub with just enough git to exercise promotion for real: refs, commits with trees and
// parents, server-side merges, fast-forward-only ref updates, annotated tags, pull requests, comments.

import type { Fetcher, HttpRequestInit, HttpResponseLike } from '../src/http.ts';

export interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
}

export interface FakePull {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  head: string;
  headRepoId: number | null;
  baseRef: string;
  author: { login: string; id: number };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

export const OWNER_ID = 215839550;
export const REPO_ID = 1405415291;
export const REPO = 'susanbeasles/deployer';

let counter = 0;
export function fakeSha(seed: string): string {
  counter += 1;
  let h = 0x811c9dc5;
  for (const c of `${seed}:${counter}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h.toString(16).padStart(8, '0') + counter.toString(16).padStart(8, '0')).repeat(3).slice(0, 40);
}

export class FakeGitHub {
  commits = new Map<string, FakeCommit>();
  refs = new Map<string, { type: 'commit' | 'tag'; sha: string }>();
  tags = new Map<string, { tag: string; message: string; object: string }>();
  pulls = new Map<number, FakePull>();
  comments: { pr: number; body: string }[] = [];
  calls: Call[] = [];
  conflicts = new Set<string>();
  /** method + path regexp → status to return once (or always when `sticky`). */
  failures: { method: string; path: RegExp; status: number; sticky: boolean }[] = [];
  /** Called after each request; lets a test move `main` mid-promotion. */
  after?: ((call: Call) => void) | undefined;

  commit(tree: string, parents: string[], message = 'commit'): string {
    const sha = fakeSha(tree);
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  /** A repository with main at a root commit and an open PR whose head adds one commit on top of it. */
  static seeded(): { gh: FakeGitHub; main: string; head: string } {
    const gh = new FakeGitHub();
    const main = gh.commit('tree-root', [], 'root');
    gh.refs.set('heads/main', { type: 'commit', sha: main });
    const head = gh.commit('tree-feature', [main], 'feat: add thing');
    gh.refs.set('heads/feature', { type: 'commit', sha: head });
    gh.pulls.set(7, { number: 7, state: 'open', title: 'feat: add thing', body: 'Adds the thing.', head, headRepoId: REPO_ID, baseRef: 'main', author: { login: 'susanbeasles', id: OWNER_ID } });
    return { gh, main, head };
  }

  fail(method: string, path: RegExp, status: number, sticky = false): void {
    this.failures.push({ method, path, status, sticky });
  }

  isAncestor(ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const stack = [of];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  branch(name: string): string | undefined {
    return this.refs.get(`heads/${name}`)?.sha;
  }

  readonly fetcher: Fetcher = async (url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
    if (init.redirect !== 'manual') throw new Error("promoter must fetch with redirect: 'manual' (workerd rejects 'error')");
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com') throw new Error(`unexpected origin ${parsed.origin}`);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    const call: Call = { method: init.method, path: parsed.pathname, body, auth: init.headers['authorization'] ?? null };
    this.calls.push(call);
    const index = this.failures.findIndex((f) => f.method === init.method && f.path.test(parsed.pathname));
    if (index >= 0) {
      const failure = this.failures[index];
      if (failure !== undefined) {
        if (!failure.sticky) this.failures.splice(index, 1);
        return json(failure.status, { message: 'injected failure' });
      }
    }
    const result = this.route(init.method, parsed.pathname, body);
    this.after?.(call);
    return result;
  };

  private route(method: string, path: string, body: any): HttpResponseLike {
    const prefix = `/repos/${REPO}`;
    if (!path.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const p = path.slice(prefix.length);
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = p.match(/^\/pulls\/(\d+)$/))) {
      const pull = this.pulls.get(Number(m[1]));
      if (pull === undefined) return json(404, {});
      return json(200, {
        number: pull.number,
        state: pull.state,
        merged: false,
        title: pull.title,
        body: pull.body,
        user: { login: pull.author.login, id: pull.author.id },
        head: { sha: pull.head, repo: pull.headRepoId === null ? null : { id: pull.headRepoId } },
        base: { ref: pull.baseRef, repo: { id: REPO_ID, owner: { id: OWNER_ID } } },
      });
    }
    if (method === 'PATCH' && (m = p.match(/^\/pulls\/(\d+)$/))) {
      const pull = this.pulls.get(Number(m[1]));
      if (pull === undefined) return json(404, {});
      pull.state = body.state;
      return json(200, { number: pull.number, state: pull.state });
    }
    if (method === 'POST' && (m = p.match(/^\/issues\/(\d+)\/comments$/))) {
      this.comments.push({ pr: Number(m[1]), body: body.body });
      return json(201, { id: this.comments.length });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/(.+)$/))) {
      const ref = this.refs.get(m[1] as string);
      return ref === undefined ? json(404, {}) : json(200, { ref: `refs/${m[1]}`, object: ref });
    }
    if (method === 'POST' && p === '/git/refs') {
      const name = String(body.ref).replace(/^refs\//, '');
      if (this.refs.has(name)) return json(422, { message: 'Reference already exists' });
      const type = this.tags.has(body.sha) ? 'tag' : 'commit';
      this.refs.set(name, { type, sha: body.sha });
      return json(201, { ref: body.ref, object: { type, sha: body.sha } });
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/(.+)$/))) {
      const name = m[1] as string;
      const current = this.refs.get(name);
      if (current === undefined) return json(422, { message: 'Reference does not exist' });
      if (!body.force && !this.isAncestor(current.sha, body.sha)) return json(422, { message: 'Update is not a fast forward' });
      this.refs.set(name, { type: 'commit', sha: body.sha });
      return json(200, { ref: `refs/${name}`, object: { type: 'commit', sha: body.sha } });
    }
    if (method === 'DELETE' && (m = p.match(/^\/git\/refs\/(.+)$/))) {
      return this.refs.delete(m[1] as string) ? json(204, null) : json(422, { message: 'Reference does not exist' });
    }
    if (method === 'POST' && p === '/merges') {
      const base = this.branch(body.base);
      if (base === undefined) return json(404, {});
      const head = body.head as string;
      if (this.conflicts.has(head)) return json(409, { message: 'Merge conflict' });
      if (this.isAncestor(head, base)) return json(204, null);
      const tree = `merged(${this.commits.get(base)?.tree}+${this.commits.get(head)?.tree})`;
      const sha = this.commit(tree, [base, head], body.commit_message);
      this.refs.set(`heads/${body.base}`, { type: 'commit', sha });
      return json(201, { sha, commit: { tree: { sha: treeSha(tree) } } });
    }
    if (method === 'POST' && p === '/git/commits') {
      const tree = treeName(body.tree);
      const sha = this.commit(tree, body.parents, body.message);
      return json(201, { sha, tree: { sha: body.tree }, parents: body.parents.map((s: string) => ({ sha: s })) });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = this.commits.get(m[1] as string);
      if (c === undefined) return json(404, {});
      return json(200, { sha: m[1], tree: { sha: treeSha(c.tree) }, parents: c.parents.map((s) => ({ sha: s })), message: c.message });
    }
    if (method === 'POST' && p === '/git/tags') {
      const sha = fakeSha(`tag:${body.tag}`);
      this.tags.set(sha, { tag: body.tag, message: body.message, object: body.object });
      return json(201, { sha, tag: body.tag, object: { type: 'commit', sha: body.object } });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/tags\/([0-9a-f]{40})$/))) {
      const t = this.tags.get(m[1] as string);
      return t === undefined ? json(404, {}) : json(200, { sha: m[1], tag: t.tag, message: t.message, object: { type: 'commit', sha: t.object } });
    }
    return json(404, { message: `no route ${method} ${p}` });
  }
}

/** Trees are named in the model; the API speaks tree shas. The mapping is stable and reversible. */
const treeIds = new Map<string, string>();
const treeNames = new Map<string, string>();
export function treeSha(name: string): string {
  let sha = treeIds.get(name);
  if (sha === undefined) {
    sha = fakeSha(`tree:${name}`);
    treeIds.set(name, sha);
    treeNames.set(sha, name);
  }
  return sha;
}
function treeName(sha: string): string {
  return treeNames.get(sha) ?? sha;
}

function json(status: number, body: unknown): HttpResponseLike {
  const text = body === null || status === 204 ? '' : JSON.stringify(body);
  return new Response(text.length === 0 ? null : text, { status, headers: { 'content-type': 'application/json' } }) as unknown as HttpResponseLike;
}
