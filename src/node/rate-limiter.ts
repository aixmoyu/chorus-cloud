/**
 * In-memory sliding-window rate limiter standing in for the Workers Rate
 * Limit binding on Node/VPS deploys. Attached only when
 * CHORUS_CLOUD_SUB_RATE_LIMIT_RPM is set (see entry.ts) — otherwise the app
 * runs unthrottled, matching the current Workers deployment where the
 * SUBSCRIPTION_RATE_LIMITER binding is intentionally unbound (free-tier
 * friendly). Keys are subscription ids (bounded set), so memory stays flat.
 */
export class MemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { success: false };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { success: true };
  }
}
