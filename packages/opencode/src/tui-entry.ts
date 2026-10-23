import type { Plugin } from "@opencode/plugin/tui";
import { setupTuiV2 } from "./tui-v2.js";

/**
 * TUI entry point — the package's `./tui` export, read by OpenCode 2.x as a
 * default `{ id, setup }` definition. v2 ONLY: OpenCode 1.x's TUI contract
 * (`{ tui }`) is no longer provided, so the sidebar panel and `/savings` need
 * OpenCode 2.x. Metering (the server plugin) still works on 1.x and 2.x.
 */
const tuiModule: Plugin.Definition = { id: "mcp-savings", setup: setupTuiV2 };
export default tuiModule;
