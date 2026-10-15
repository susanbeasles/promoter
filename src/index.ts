// The promoter Worker. No fetch handler: the only way in is the authorizer's service binding calling
// `prepare` or `promote`. Each request is executed inside the repository's own Durable Object, which
// serializes every promotion of that repository and keeps the shadow records in SQLite.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { Env as ConfigEnv } from './config.ts';
import { createDeps, KeyCache, type CommonDeps } from './deps.ts';
import { InstallationTokenCache } from './github-app.ts';
import { prepare, promote, reconcileAll, type Prepared, type Promoted, type PromotionDeps } from './promotion.ts';
import { refusal, toRefusal, type Refusal } from './refusal.ts';
import { validateRequest, type PromotionRequest } from './request.ts';
import { SqlShadowStore } from './store.ts';

export interface Env extends ConfigEnv {
  readonly LEDGER: DurableObjectNamespace<PromotionLedger>;
}

export type Result = Prepared | Promoted | Refusal;

const tokenCache = new InstallationTokenCache();
const keyCache = new KeyCache();
/** Follow-up retry cadence after a promotion left steps pending. */
const RETRY_MS = 5 * 60_000;

function wire(env: Env): CommonDeps {
  return createDeps({ env, fetcher: (url, init) => fetch(url, init), sink: (line) => console.log(line), tokenCache, keyCache });
}

export class PromotionLedger extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();

  /** One operation at a time per repository: the next starts only after the previous settled. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #deps(repoId: number): PromotionDeps {
    const common = wire(this.env);
    return {
      fetcher: common.fetcher,
      token: common.token,
      logger: common.logger,
      clock: common.clock,
      ownerId: common.config().ownerId,
      store: new SqlShadowStore(this.ctx.storage.sql, repoId),
      schedule: async (atMs) => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > atMs) await this.ctx.storage.setAlarm(atMs);
      },
    };
  }

  async execute(request: PromotionRequest): Promise<Result> {
    return this.#serial(async () => {
      try {
        const deps = this.#deps(request.subject.repo_id);
        await this.ctx.storage.put('repo', request.subject.repo);
        await this.ctx.storage.put('repo_id', request.subject.repo_id);
        const result = request.action === 'shadow.prepare' ? await prepare(request, deps) : await promote(request, deps);
        if (result.ok && result.action === 'promote' && result.pending.length > 0) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
        return result;
      } catch (error) {
        return toRefusal(error);
      }
    });
  }

  override async alarm(): Promise<void> {
    await this.#serial(async () => {
      const repo = await this.ctx.storage.get<string>('repo');
      const repoId = await this.ctx.storage.get<number>('repo_id');
      if (repo === undefined || repoId === undefined) return;
      const remaining = await reconcileAll(repo, this.#deps(repoId));
      if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    });
  }
}

export class Promoter extends WorkerEntrypoint<Env> {
  #route(input: unknown, action: PromotionRequest['action']): Promise<Result> {
    let request: PromotionRequest;
    try {
      request = validateRequest(input, wire(this.env).config().owner);
    } catch (error) {
      return Promise.resolve(toRefusal(error));
    }
    if (request.action !== action) return Promise.resolve(refusal('bad_action'));
    const stub = this.env.LEDGER.get(this.env.LEDGER.idFromName(String(request.subject.repo_id)));
    return stub.execute(request) as Promise<Result>;
  }

  /** Build or reuse the shadow candidate for a pull request. Called only by the authorizer. */
  prepare(request: unknown): Promise<Result> {
    return this.#route(request, 'shadow.prepare');
  }

  /** Fast-forward `main` to a verified candidate and tag it with provenance. Called only by the authorizer. */
  promote(request: unknown): Promise<Result> {
    return this.#route(request, 'promote');
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
