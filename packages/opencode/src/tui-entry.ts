import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { tui } from "./panel.js";

/**
 * TUI entry point — referenced by ~/.config/opencode/tui.json (a DIFFERENT
 * loader than opencode.json). OpenCode's TUI loader reads a module's DEFAULT
 * export shaped `{ id?, tui, server?: never }`. This is kept SEPARATE from the
 * server plugin (plugin.ts, referenced by opencode.json) because that loader
 * errors if a file's default export doesn't expose `server()`, while this one
 * requires `tui` and forbids `server`. Two loaders, two shapes, two files.
 */
const tuiModule: TuiPluginModule = { id: "mcp-savings", tui };
export default tuiModule;
