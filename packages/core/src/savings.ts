import type { ServerMeasurement } from "./measure.js";

/**
 * ============================================================================
 * The PAY / SAVED split — ONE implementation, deliberately
 * ============================================================================
 * This rule was previously written out three times: once in cli.ts, once in
 * the TUI sidebar (opencode's rows.ts) and once in the TUI report dialog
 * (opencode's command.ts). All three carried a comment promising that the
 * CLI report and the TUI report "never disagree" — a promise kept by hand,
 * across two packages, with no test holding them together.
 *
 * They are one function now, so agreement is structural rather than
 * aspirational.
 *
 * THE RULE, and why each clause is there:
 *
 *   PAY   = servers currently connected  -> what you spend every request
 *   SAVED = servers currently turned off -> what you already stopped spending
 *
 * The two are NEVER added together. Their sum is a bigger, more impressive
 * number that describes nothing a user can act on: you cannot "save" what
 * you are still paying, and you are not paying what you already switched
 * off. Reporting one conflated figure is the mistake this codebase already
 * corrected once.
 *
 * `enabled` missing means CONNECTED, not disconnected. A measurement taken
 * before that field existed was, by definition, taken against a server that
 * answered. Defaulting the other way would invent savings nobody made.
 *
 * Only `ok` servers contribute to either figure. A server whose measurement
 * failed has no number, and counting it as 0 would claim we know it is free.
 * It stays visible in the lists below so a caller can still render it — as
 * an error, never as a zero.
 *
 * A single `null` token count poisons its whole side. `tokens` is null for
 * any model without a local tokenizer, and summing the rest would present a
 * partial figure with the same confidence as a complete one. Bytes are
 * always exact, so they keep summing regardless — which is why callers gate
 * the SAVED line on `savedBytes` rather than on `savedTokens`.
 * ============================================================================
 */
export interface PayAndSaved {
  /** Connected and successfully measured: the PAY figure, and the bars. */
  enabledOk: ServerMeasurement[];
  /** Disconnected and successfully measured: the SAVED figure. */
  disabledOk: ServerMeasurement[];
  /**
   * EVERY disconnected server, including ones whose measurement failed —
   * so an "off" list can keep a broken server visible as `n/a` instead of
   * silently dropping a server the user has configured.
   */
  disabled: ServerMeasurement[];

  /** Exact. Sums even when tokens are unavailable. */
  payBytes: number;
  /** `null` when any connected server could not be tokenized. */
  payTokens: number | null;
  payCount: number;

  /** Exact. Gate the SAVED line on this, not on `savedTokens`. */
  savedBytes: number;
  /** `null` when any disconnected server could not be tokenized. */
  savedTokens: number | null;
  savedCount: number;
}

/** Sums `bytes` across measurements. Always exact. */
function sumBytes(results: readonly ServerMeasurement[]): number {
  return results.reduce((sum, result) => sum + result.bytes, 0);
}

/** Sums `tokens`, or returns null if any single measurement lacks a count. */
function sumTokens(results: readonly ServerMeasurement[]): number | null {
  if (results.some((result) => result.tokens === null)) return null;
  return results.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
}

/**
 * Splits measurements into what you pay for right now and what you have
 * already stopped paying for. See the rule documented above.
 */
export function splitPayAndSaved(results: readonly ServerMeasurement[]): PayAndSaved {
  const enabledOk = results.filter((result) => result.enabled !== false && result.ok);
  const disabled = results.filter((result) => result.enabled === false);
  const disabledOk = disabled.filter((result) => result.ok);

  return {
    enabledOk,
    disabledOk,
    disabled,
    payBytes: sumBytes(enabledOk),
    payTokens: sumTokens(enabledOk),
    payCount: enabledOk.length,
    savedBytes: sumBytes(disabledOk),
    savedTokens: sumTokens(disabledOk),
    savedCount: disabledOk.length,
  };
}
