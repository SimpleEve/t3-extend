import { describe, expect, it } from "vite-plus/test";

import { resolveDndAccessibility } from "./TranslatedDndContext";

// A translator that tags its output makes the source of each field visible without any copy text.
const tagged = (tag: string) => (source: string) => `${tag}:${source}`;
const announce = { active: { id: "a" } } as never;

describe("resolveDndAccessibility", () => {
  it("builds the translated defaults once per translator", () => {
    const zh = tagged("zh");
    expect(resolveDndAccessibility(zh, undefined)).toBe(resolveDndAccessibility(zh, undefined));
    expect(resolveDndAccessibility(tagged("de"), undefined)).not.toBe(
      resolveDndAccessibility(zh, undefined),
    );
  });

  it("lets a caller's accessibility win only where it provides a field", () => {
    const zh = tagged("zh");
    // Partial on purpose: the types demand whole objects, runtime callers may not give them.
    const caller = {
      announcements: { onDragStart: () => "caller start" },
      screenReaderInstructions: { draggable: undefined },
      restoreFocus: false,
    } as unknown as Parameters<typeof resolveDndAccessibility>[1];
    const merged = resolveDndAccessibility(zh, caller);
    expect(merged?.announcements?.onDragStart?.(announce)).toBe("caller start");
    expect(merged.announcements?.onDragCancel?.(announce)).toMatch(/^zh:/);
    expect(merged.screenReaderInstructions?.draggable).toMatch(/^zh:/);
    expect(merged.restoreFocus).toBe(false);
    expect(resolveDndAccessibility(zh, caller)).toBe(merged);
  });
});
