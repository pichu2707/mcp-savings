import type { CliRenderer } from "@opentui/core";
import { solid, solidJs } from "./solid.js";

const { createComponent, createElement, RendererContext, spread } = solid;
const { createRoot } = solidJs;

/**
 * Minimal JSX runtime, local to this package, for building @opentui/solid
 * trees without a JSX transform.
 *
 * Why not `@opentui/solid/jsx-runtime`, and why `mountWithRenderer` below:
 * a plugin installed from a package gets its OWN copy of @opentui/solid and
 * solid-js next to it (they are peer dependencies). Solid keeps its owner and
 * context in module state, so that copy cannot see the host's renderer
 * context and every element creation threw "No renderer found". Instead of
 * relying on the host to swap those imports, the tree is mounted in this
 * copy's own root with the host's renderer provided explicitly.
 *
 * Behaviour mirrors @opentui/solid's own jsx-runtime: function types become
 * components, strings become intrinsic elements with props spread on.
 */
export function jsx(type: unknown, props: Record<string, unknown> = {}): unknown {
  const { key: _key, ...rest } = props;
  if (typeof type === "function") {
    return createComponent(type as (p: Record<string, unknown>) => unknown, rest);
  }
  const element = createElement(type as string);
  spread(element, rest);
  return element;
}

/**
 * Builds a tree under this package's own solid root, providing the host's
 * renderer so element creation works whichever @opentui/solid instance this
 * module resolved to. Returns the tree and registers its disposer in
 * `disposers` so the plugin's cleanup can release it.
 */
export function mountWithRenderer(
  renderer: CliRenderer,
  disposers: Set<() => void>,
  build: () => unknown,
): unknown {
  return createRoot((dispose) => {
    disposers.add(dispose);
    return createComponent(RendererContext.Provider, {
      value: renderer,
      get children() {
        return build();
      },
    });
  });
}
