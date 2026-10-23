import type * as SolidJs from "solid-js";
import type * as OpentuiSolid from "@opentui/solid";

/**
 * The host's own @opentui/solid and solid-js, falling back to this package's
 * installed copies.
 *
 * A package-installed plugin gets its own copy of both next to it (they are
 * peer dependencies). Solid keeps its owner/context in module state and
 * OpenTUI checks node identity on removal, so mixing a second copy with the
 * host's tree fails ("No renderer found", "remove expects a renderable child
 * object"). OpenCode 2.x registers the host's instances as virtual modules
 * named `opentui:runtime-module:<encoded specifier>` and normally rewrites a
 * plugin's imports to them, but that rewrite was observed not to apply to
 * plugins installed from `file:` specs. Importing the virtual modules by name
 * gets the host's instances regardless; outside OpenCode (tests, Node) the
 * import fails and the installed copies are used.
 */
const RUNTIME_MODULE_PREFIX = "opentui:runtime-module:";

async function load<T>(specifier: string, installed: () => Promise<T>): Promise<T> {
  try {
    return (await import(RUNTIME_MODULE_PREFIX + encodeURIComponent(specifier))) as T;
  } catch {
    return installed();
  }
}

export const solid = await load<typeof OpentuiSolid>("@opentui/solid", () => import("@opentui/solid"));
export const solidJs = await load<typeof SolidJs>("solid-js", () => import("solid-js"));
