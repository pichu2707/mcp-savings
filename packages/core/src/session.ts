import { EMPTY_TOKEN_USAGE, type TokenUsage } from "./types.js";

/**
 * Accumulates real, provider-reported token usage for a session.
 *
 * Hosts typically re-emit the SAME assistant message's cumulative token
 * count multiple times as it streams (e.g. OpenCode's `message.updated`
 * fires repeatedly for one messageID). To avoid double-counting, callers
 * should key each `add()` call by a stable message id — SessionMeter keeps
 * the LATEST usage per key and sums across keys in `totals()`, rather than
 * naively summing every event.
 */
export class SessionMeter {
  private readonly byMessageId = new Map<string, TokenUsage>();

  /** Upserts the latest known cumulative usage for a given message id. */
  add(messageId: string, usage: TokenUsage): void {
    this.byMessageId.set(messageId, usage);
  }

  /** Sums the latest usage recorded per message id. */
  totals(): TokenUsage {
    let totals = { ...EMPTY_TOKEN_USAGE };
    for (const usage of this.byMessageId.values()) {
      totals = {
        input: totals.input + usage.input,
        output: totals.output + usage.output,
        reasoning: totals.reasoning + usage.reasoning,
        cacheRead: totals.cacheRead + usage.cacheRead,
        cacheWrite: totals.cacheWrite + usage.cacheWrite,
      };
    }
    return totals;
  }

  reset(): void {
    this.byMessageId.clear();
  }
}
