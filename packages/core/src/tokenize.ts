import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * ============================================================================
 * HONESTY NOTE — local tokenization is exact ONLY for the OpenAI o200k_base
 * family (gpt-4o / gpt-4.1 / gpt-5*). For every other model (including all
 * Claude models) there is no public, accurate local tokenizer we can bundle
 * — Anthropic's tokenizer is not published as an offline library — so
 * `countTokens` returns `null` for those models rather than guessing.
 *
 * `null` is a deliberate, meaningful value throughout this codebase: it
 * means "no accurate local tokenizer available for this model", not "zero
 * tokens". Never coerce it to 0 or otherwise paper over it in output.
 * ============================================================================
 */

/** Model name substrings that use OpenAI's o200k_base encoding. */
const O200K_MODEL_PREFIXES = ["gpt-4o", "gpt-4.1", "gpt-5"];

/** Default model assumed when a caller (e.g. the CLI) doesn't specify one. */
export const DEFAULT_MODEL = "gpt-5.4";

/**
 * Resolves the tiktoken encoding name for a model string, or `null` if we
 * have no accurate local tokenizer for it (see HONESTY NOTE above).
 */
export function encodingForModel(model: string): "o200k_base" | null {
  const lower = model.toLowerCase();
  return O200K_MODEL_PREFIXES.some((prefix) => lower.includes(prefix)) ? "o200k_base" : null;
}

let cachedEncoder: Tiktoken | undefined;

function getO200kEncoder(): Tiktoken {
  if (!cachedEncoder) cachedEncoder = getEncoding("o200k_base");
  return cachedEncoder;
}

/**
 * Counts tokens for `text` as they would be tokenized for `model`.
 *
 * Returns `null` when `model` has no accurate local tokenizer (see HONESTY
 * NOTE above) — callers must treat `null` as "unknown", never as 0.
 */
export function countTokens(text: string, model: string): number | null {
  if (encodingForModel(model) === null) return null;
  return getO200kEncoder().encode(text).length;
}
