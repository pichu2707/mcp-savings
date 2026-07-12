// packages/core/test/weigh.test.mjs
//
// Holds `bytes` to its name.
//
// The bug these tests exist to prevent is not a crash — it is a SILENT
// disagreement. `JSON.stringify(tool).length` counts UTF-16 code units, and
// UTF-16 code units happen to equal UTF-8 bytes for every ASCII character.
// So a wrong implementation passes any ASCII fixture, ships, and only starts
// lying the day a tool description contains an accent or an emoji.
//
// That is precisely the case that matters: OxideGate measures these same
// schemas as real UTF-8 bytes on the wire and oxidegate-lens reports them
// under the same field name (`bytes`). Two tools, same field, same shape —
// if the unit drifts, the numbers stop being comparable and nothing errors.
//
// Hence: every assertion below that could be satisfied by `.length` is
// deliberately paired with one that cannot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { utf8Bytes, weighTools } from "../dist/index.js";

test("utf8Bytes agrees with String.length on pure ASCII", () => {
  // The trap: this passes with the wrong implementation too. It is here to
  // pin the ASCII case, not to prove correctness.
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes(""), 0);
});

test("utf8Bytes counts BYTES, not UTF-16 code units", () => {
  // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes.
  assert.equal("é".length, 1);
  assert.equal(utf8Bytes("é"), 2);

  // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes.
  assert.equal("€".length, 1);
  assert.equal(utf8Bytes("€"), 3);

  // '🔥' is a surrogate pair: 2 UTF-16 code units, 4 UTF-8 bytes.
  assert.equal("🔥".length, 2);
  assert.equal(utf8Bytes("🔥"), 4);
});

test("weighTools reports UTF-8 bytes of the serialized tool", () => {
  const tool = { id: "t", description: "a", parameters: {} };
  const serialized = JSON.stringify(tool);

  assert.equal(weighTools([tool])[0].bytes, Buffer.byteLength(serialized, "utf8"));
});

test("weighTools does not undercount a non-ASCII description", () => {
  // The regression this file exists for. A tool whose description carries
  // accents — ordinary Spanish prose, not an exotic edge case.
  const tool = {
    id: "mcp__docs__buscar",
    description: "Búsqueda semántica sobre la documentación técnica.",
    parameters: {},
  };
  const serialized = JSON.stringify(tool);

  const [weighed] = weighTools([tool]);

  // The wire truth: what OxideGate would count for these same bytes.
  assert.equal(weighed.bytes, Buffer.byteLength(serialized, "utf8"));

  // And it must be STRICTLY MORE than the UTF-16 count — otherwise the old
  // `.length` implementation is still in place and this test is asleep.
  assert.ok(
    weighed.bytes > serialized.length,
    `expected UTF-8 bytes (${weighed.bytes}) > UTF-16 code units (${serialized.length}); ` +
      "if these are equal, bytes are being counted as String.length again",
  );
});

test("weighTools sums nothing and invents nothing on an empty list", () => {
  assert.deepEqual(weighTools([]), []);
});
