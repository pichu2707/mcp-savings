import type { Plugin } from "@opencode/plugin";
import type { Plugin as PluginV1 } from "@opencode-ai/plugin";
import { OpencodeSavingsPlugin } from "./plugin.js";
import { setupV2 } from "./v2.js";

/**
 * The package's `./server` export. Both OpenCode generations read it, each
 * looking at its own keys of the same default export:
 *   - v2 reads `{ id, setup }` (and ignores `server`).
 *   - v1 (>= 1.19) reads `{ id?, server }` (and ignores `setup`). Without
 *     `server` it logs "failed to load plugin"; older v1 releases that only
 *     read the root export keep using plugin.ts's named export.
 *
 * The logic lives in v2.ts / plugin.ts so tests and the legacy path can reach
 * it; this file only assembles the entry.
 *
 * `Plugin.define()` from @opencode/plugin is the identity function, so this
 * is a plain object typed against the real contract instead of a runtime
 * import: @opencode/plugin stays a type-only devDependency and v1 installs
 * don't download v2's dependency tree.
 */
const plugin: Plugin.Plugin & { server: PluginV1 } = {
  id: "mcp-savings",
  setup: setupV2,
  server: OpencodeSavingsPlugin,
};
export default plugin;
