// packages/core/test/tokenize.test.mjs
//
// Holds the line between a number and "n/a".
//
// There is no public, accurate offline tokenizer for Claude models, so this
// module refuses to guess: `countTokens` returns `null` for anything outside
// OpenAI's o200k_base family. That `null` then travels through measure.ts,
// splitPayAndSaved, the CLI tables and the TUI panel, and every one of them
// has a test asserting it renders as "n/a" and never as 0.
//
// This file guards the source of that value. Two ways it can go wrong:
//
//   - A model that SHOULD tokenize stops matching, and real numbers silently
//     become "n/a" across the whole tool. Nothing errors; the report just
//     stops being useful.
//   - A model that CANNOT be tokenized starts matching, and o200k counts get
//     presented as if they were Claude's. That is worse: a wrong number
//     wearing the confidence of a right one.
//
// The matcher uses `includes`, not `startsWith`, which makes both directions
// easier to hit than they look. The characterisation test at the bottom says
// so out loud.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodingForModel, countTokens, DEFAULT_MODEL } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Which models we claim to tokenize
// ---------------------------------------------------------------------------

test("the three OpenAI families we bundle a tokenizer for resolve to o200k_base", () => {
  for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-5", "gpt-5.4"]) {
    assert.equal(encodingForModel(model), "o200k_base", model);
  }
});

test("models we have no tokenizer for resolve to null, not to a fallback", () => {
  // A fallback encoding would produce plausible-looking numbers for the wrong
  // tokenizer — the failure this module is written to avoid.
  for (const model of ["claude-3-opus", "claude-sonnet-4-5", "llama-3", "gemini-2.0", ""]) {
    assert.equal(encodingForModel(model), null, model);
  }
});

test("plain gpt-4 is NOT treated as o200k", () => {
  // gpt-4 uses cl100k, which this module does not bundle. It is one character
  // away from gpt-4o and must not be swept in with it.
  assert.equal(encodingForModel("gpt-4"), null);
  assert.equal(encodingForModel("gpt-4-turbo"), null);
  assert.equal(encodingForModel("gpt-3.5-turbo"), null);
});

test("model matching is case-insensitive", () => {
  // Hosts pass model ids through with whatever casing they received.
  assert.equal(encodingForModel("GPT-4O"), "o200k_base");
  assert.equal(encodingForModel("Gpt-5"), "o200k_base");
});

test("a provider-prefixed model id still matches", () => {
  // OpenCode and others hand over ids like "openai/gpt-4o", so anchoring the
  // match to the start of the string would silently disable tokenization for
  // every such host.
  assert.equal(encodingForModel("openai/gpt-4o"), "o200k_base");
  assert.equal(encodingForModel("azure:gpt-4.1-mini"), "o200k_base");
});

test("CHARACTERISATION: the match is a substring test, so it is greedy", () => {
  // `includes`, not `startsWith`. This is what makes provider-prefixed ids
  // work, and it is also why an unrelated model whose name happens to embed
  // one of the prefixes would be tokenized with the wrong encoding. Pinned,
  // not endorsed — tightening it would break the prefix case above.
  assert.equal(encodingForModel("some-vendor-gpt-4o-clone"), "o200k_base");
  assert.equal(encodingForModel("definitely-not-gpt-5-really"), "o200k_base");
});

// ---------------------------------------------------------------------------
// The default model must be one we can actually tokenize
// ---------------------------------------------------------------------------

test("DEFAULT_MODEL is a model this module can tokenize", () => {
  // The CLI falls back to DEFAULT_MODEL whenever a snapshot carries no model
  // id. If it ever changed to something outside the o200k family, every
  // `mcp-savings measure` on a fresh machine would print n/a in the TOKENS
  // column and look broken, with nothing pointing at the cause.
  assert.equal(encodingForModel(DEFAULT_MODEL), "o200k_base", `DEFAULT_MODEL is ${DEFAULT_MODEL}`);
  assert.equal(typeof countTokens("hello", DEFAULT_MODEL), "number");
});

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

test("countTokens returns null for a model with no local tokenizer", () => {
  assert.equal(countTokens("a fairly long piece of prose", "claude-3-opus"), null);
});

test("null is returned regardless of how much text there is", () => {
  // Guards against a shortcut that returns 0 for empty input before checking
  // the model — that would make "unknown" and "nothing" the same value.
  assert.equal(countTokens("", "claude-3-opus"), null);
  assert.equal(countTokens("x".repeat(10_000), "claude-3-opus"), null);
});

test("countTokens counts real tokens for a supported model", () => {
  const tokens = countTokens("The quick brown fox jumps over the lazy dog.", "gpt-4o");

  assert.equal(typeof tokens, "number");
  assert.ok(tokens > 0);
  assert.ok(tokens < 44, "tokens must be fewer than characters for ordinary English");
});

test("empty text is zero tokens, which is not the same as null", () => {
  // 0 says "measured, nothing there". null says "we cannot measure". The
  // whole codebase depends on those staying distinct.
  const tokens = countTokens("", "gpt-4o");

  assert.equal(tokens, 0);
  assert.notEqual(tokens, null);
});

test("more text costs more tokens", () => {
  const short = countTokens("hello", "gpt-4o");
  const long = countTokens("hello ".repeat(100), "gpt-4o");

  assert.ok(long > short);
});

test("tokens are not a rename of characters or bytes", () => {
  // If these ever coincide, something is counting length instead of
  // tokenizing — the same category of mistake as bytes-vs-UTF-16.
  const text = "Búsqueda semántica sobre documentación técnica.";
  const tokens = countTokens(text, "gpt-4o");

  assert.notEqual(tokens, text.length);
  assert.notEqual(tokens, Buffer.byteLength(text, "utf8"));
});

test("the cached encoder returns the same count every time", () => {
  // The encoder is memoised in a module-level variable. A stateful tiktoken
  // instance that drifted between calls would make every measurement
  // irreproducible.
  const text = JSON.stringify({ name: "search", description: "Finds things.", inputSchema: {} });
  const counts = new Set([
    countTokens(text, "gpt-4o"),
    countTokens(text, "gpt-4.1"),
    countTokens(text, "gpt-5"),
  ]);

  assert.equal(counts.size, 1, "the same text and encoding must always count the same");
});
