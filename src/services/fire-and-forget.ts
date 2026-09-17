import type { Context } from 'hono';

/**
 * Schedule background work on whichever mechanism the current runtime
 * provides. On Workers this delegates to `executionCtx.waitUntil` so the
 * isolate stays alive until the promise settles; on runtimes without an
 * ExecutionContext (the Node/VPS entry) it detaches the promise and swallows
 * rejections, keeping the fire-and-forget contract.
 *
 * Note: Hono's `c.executionCtx` getter THROWS when no ExecutionContext was
 * provided (Node) — hence the try/catch rather than an optional call.
 */
export function fireAndForget<T>(c: Context, promise: Promise<T>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
}
