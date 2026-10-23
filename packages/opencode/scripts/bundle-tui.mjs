// Bundles the TUI entry into ONE dist/tui-entry.js, after tsc has emitted the
// per-file output (tsc still provides the .d.ts files and every other entry).
//
// Why a single file: OpenCode 2.x swaps a plugin's `@opentui/solid`,
// `@opentui/core` and `solid-js` imports for the host's own instances, which
// is what carries the renderer context. It does that by rewriting the module
// it loads as the entry; sibling files loaded from node_modules were observed
// NOT to be rewritten and then ran against a second, context-less copy
// ("No renderer found"). With everything of ours inlined into the entry, the
// entry is the only file that imports those modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/tui-entry.ts"],
  outfile: "dist/tui-entry.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["@opentui/solid", "@opentui/core", "solid-js", "@javilazaro/mcp-savings-core"],
  logLevel: "warning",
});
