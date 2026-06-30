/**
 * Reads the resolved variables for the current composition.
 *
 * Top-level path: declared defaults from `<html data-composition-variables="...">`
 * merged with `window.__hfVariables` (set at render time by the engine when
 * the user passes `hyperframes render --variables '<json>'`).
 *
 * Sub-comp path (per-instance scoping): when called inside a sub-composition
 * script wrapped by `compositionScoping.ts`, the wrapper shadows
 * `__hyperframes.getVariables` with a scoped variant that returns the
 * pre-merged values from `window.__hfVariablesByComp[compositionId]`. The
 * loader populates that table before running scripts, layering the host
 * element's `data-variable-values` over the sub-comp's declared defaults.
 *
 * Returns `Partial<T>` because not every declared variable is guaranteed to
 * have a default, and not every key in `__hfVariables` is guaranteed to be
 * declared. Callers are expected to destructure with their own fallbacks
 * where strictness matters:
 *
 *     const { title = "Untitled", theme = "light" } = getVariables<MyVars>();
 */
export function getVariables<
  T extends Record<string, unknown> = Record<string, unknown>,
>(): Partial<T> {
  if (typeof document === "undefined") return {} as Partial<T>;

  const declaredDefaults = readDeclaredDefaults(document.documentElement);
  const overrides = readOverrides();

  return { ...declaredDefaults, ...overrides } as Partial<T>;
}

/**
 * Extract `{id: default}` map from an element's `data-composition-variables`
 * attribute. Returns an empty object when the attribute is missing, the JSON
 * is unparseable, or the payload isn't an array. Exported so the
 * compositionLoader can compute the same defaults map for sub-comp instances.
 */
export function readDeclaredDefaults(root: Element | null): Record<string, unknown> {
  if (!root) return {};
  const raw = root.getAttribute("data-composition-variables");
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};

  const out: Record<string, unknown> = {};
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !("default" in e)) continue;
    out[e.id] = e.default;
  }
  return out;
}

function readOverrides(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const raw = (window as Window & { __hfVariables?: unknown }).__hfVariables;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}
