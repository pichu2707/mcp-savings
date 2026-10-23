import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Plugin } from "@opencode/plugin/tui";
import { tui } from "./panel.js";
import { setupTuiV2 } from "./tui-v2.js";

/**
 * TUI entry point — referenced by ~/.config/opencode/tui.json (a DIFFERENT
 * loader than opencode.json) and exposed as the package's `./tui` export.
 *
 * The default export carries BOTH contracts in one object, because each
 * loader only reads its own keys:
 *   - OpenCode v1 reads `{ id?, tui, server?: never }` and ignores `setup`.
 *   - OpenCode v2 reads `{ id, setup }` and ignores `tui`.
 * This is kept SEPARATE from the server plugin (plugin.ts / server.ts)
 * because the server loader needs `server`/`setup` while v1's TUI loader
 * forbids `server`. Two loaders, two shapes, two files.
 */
const tuiModule: TuiPluginModule & Plugin.Definition = { id: "mcp-savings", tui, setup: setupTuiV2 };
export default tuiModule;
