// Lazy loader for @nut-tree-fork/nut-js (prebuilt native bindings for macOS and Windows).
// Loaded only when desktop control is actually used, so the rest of the service never pays for it
// and MOCK mode never touches the native layer.
type Nut = typeof import("@nut-tree-fork/nut-js");

let cached: Promise<Nut> | null = null;

export function loadNut(): Promise<Nut> {
  cached ??= import("@nut-tree-fork/nut-js").then((m) => {
    const nut = ((m as { default?: Nut }).default?.mouse ? (m as { default?: Nut }).default! : m) as Nut;
    nut.mouse.config.autoDelayMs = 2;
    nut.mouse.config.mouseSpeed = 2000;
    nut.keyboard.config.autoDelayMs = 8;
    return nut;
  });
  return cached;
}
