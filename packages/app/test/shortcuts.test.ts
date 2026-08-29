import { describe, expect, it } from "vitest";
import { NO_MODS } from "../src/gestures/gesture.js";
import {
  matchingShortcuts,
  matchShortcut,
  SHORTCUTS,
  type ShortcutId,
  shortcutHint,
  shortcutsByGroup,
} from "../src/shortcuts.js";

const press = (key: string, mods: Partial<typeof NO_MODS> = {}): ShortcutId | null =>
  matchShortcut({ key, mods: { ...NO_MODS, ...mods } });

describe("matchShortcut", () => {
  it("resolves the tool keys from the spec's table", () => {
    expect(press("p")).toBe("tool.pencil");
    expect(press("b")).toBe("tool.box");
    expect(press("l")).toBe("tool.line");
    expect(press("v")).toBe("tool.select");
    expect(press("t")).toBe("tool.text");
    expect(press("g")).toBe("tool.fill");
    expect(press("i")).toBe("tool.eyedropper");
  });

  it("is case-insensitive, so Caps Lock does not break the tools", () => {
    expect(press("B")).toBe("tool.box");
    expect(press("V")).toBe("tool.select");
  });

  it("distinguishes undo from redo by Shift", () => {
    // The specificity rule: Cmd+Shift+Z must resolve to redo, not undo.
    expect(press("z", { meta: true })).toBe("edit.undo");
    expect(press("z", { meta: true, shift: true })).toBe("edit.redo");
  });

  it("accepts Ctrl as equivalent to Cmd", () => {
    expect(press("z", { ctrl: true })).toBe("edit.undo");
    expect(press("z", { ctrl: true, shift: true })).toBe("edit.redo");
  });

  it("does not fire a tool key when a modifier is held", () => {
    // Cmd+B is a browser/OS shortcut, not the box tool.
    expect(press("b", { meta: true })).toBeNull();
    expect(press("p", { ctrl: true })).toBeNull();
  });

  it("resolves editing and view keys", () => {
    expect(press("Escape")).toBe("edit.cancel");
    expect(press("Delete")).toBe("edit.delete");
    expect(press("Backspace")).toBe("edit.delete");
    expect(press("0")).toBe("view.zoomReset");
    expect(press("[")).toBe("layer.previous");
    expect(press("]")).toBe("layer.next");
  });

  it("accepts both glyphs for zoom, since + and = share a key", () => {
    expect(press("+")).toBe("view.zoomIn");
    expect(press("=")).toBe("view.zoomIn");
    expect(press("-")).toBe("view.zoomOut");
    expect(press("_")).toBe("view.zoomOut");
  });

  it("returns null for an unbound key", () => {
    expect(press("q")).toBeNull();
    expect(press("F13")).toBeNull();
  });
});

describe("the registry itself", () => {
  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no ambiguous binding — every combination resolves to one shortcut", () => {
    // Guards against a new entry silently shadowing an existing one.
    for (const shortcut of SHORTCUTS) {
      for (const key of shortcut.keys) {
        const resolved = matchShortcut({
          key,
          mods: {
            ...NO_MODS,
            meta: shortcut.meta ?? false,
            shift: shortcut.shift ?? false,
          },
        });
        expect(resolved, `${shortcut.id} (${key}) is shadowed by ${resolved}`).toBe(shortcut.id);
      }
    }
  });

  it("never produces more than one candidate for any keypress", () => {
    // This is the property that lets matchShortcut take the first match without
    // ranking. Swept over every declared key against all four modifier
    // combinations — if a future entry collides, this fails instead of silently
    // shadowing.
    const keys = new Set(SHORTCUTS.flatMap((s) => s.keys));
    for (const key of keys) {
      for (const meta of [false, true]) {
        for (const shift of [false, true]) {
          const matches = matchingShortcuts({ key, mods: { ...NO_MODS, meta, shift } });
          expect(
            matches.length,
            `${key} (meta=${meta} shift=${shift}) matched ${matches.map((m) => m.id).join(", ")}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("groups every shortcut for the generated help panel", () => {
    const grouped = shortcutsByGroup();
    const total = grouped.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(SHORTCUTS.length);
    expect(grouped.map((g) => g.group)).toEqual(["File", "Tools", "Edit", "View", "Layer"]);
  });

  it("renders a hint for every shortcut", () => {
    for (const shortcut of SHORTCUTS) {
      const hint = shortcutHint(shortcut);
      expect(hint.length, shortcut.id).toBeGreaterThan(0);
    }
    expect(shortcutHint(SHORTCUTS.find((s) => s.id === "edit.redo")!)).toBe("⌘⇧Z");
    expect(shortcutHint(SHORTCUTS.find((s) => s.id === "edit.undo")!)).toBe("⌘Z");
    expect(shortcutHint(SHORTCUTS.find((s) => s.id === "tool.box")!)).toBe("B");
    expect(shortcutHint(SHORTCUTS.find((s) => s.id === "edit.cancel")!)).toBe("Escape");
  });
});
