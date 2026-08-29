/**
 * One registry for every keyboard shortcut.
 *
 * The spec requires this so the eventual "shortcuts help" panel is *generated*
 * rather than hand-maintained — a hand-written help panel drifts from reality on
 * the first change. `matchShortcut` is pure and takes a plain descriptor rather
 * than a `KeyboardEvent`, so the whole table is unit-testable with no DOM.
 */

import type { Modifiers } from "./gestures/gesture.js";

export type ShortcutId =
  | "tool.pencil"
  | "tool.box"
  | "tool.line"
  | "tool.select"
  | "tool.text"
  | "tool.fill"
  | "tool.eyedropper"
  | "edit.undo"
  | "edit.redo"
  | "edit.delete"
  | "edit.cancel"
  | "file.save"
  | "file.saveAs"
  | "file.open"
  | "file.export"
  | "edit.copy"
  | "edit.cut"
  | "edit.paste"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.toggleGrid"
  | "layer.next"
  | "layer.previous";

export type ShortcutGroup = "File" | "Tools" | "Edit" | "View" | "Layer";

export interface Shortcut {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  /** Human label for the help panel. */
  readonly label: string;
  /**
   * `event.key` values that trigger this, compared case-insensitively.
   *
   * Typed as non-empty so `keys[0]` needs no fallback — a shortcut with no key
   * would be meaningless.
   */
  readonly keys: readonly [string, ...string[]];
  /** Require Cmd/Ctrl. Default false. */
  readonly meta?: boolean;
  /** Require Shift. When omitted, Shift is ignored rather than forbidden. */
  readonly shift?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "file.save", group: "File", label: "Save", keys: ["s"], meta: true, shift: false },
  { id: "file.saveAs", group: "File", label: "Save as", keys: ["s"], meta: true, shift: true },
  { id: "file.open", group: "File", label: "Open", keys: ["o"], meta: true },
  { id: "file.export", group: "File", label: "Export", keys: ["e"], meta: true },

  { id: "tool.pencil", group: "Tools", label: "Pencil", keys: ["p"] },
  { id: "tool.box", group: "Tools", label: "Box", keys: ["b"] },
  { id: "tool.line", group: "Tools", label: "Line", keys: ["l"] },
  { id: "tool.select", group: "Tools", label: "Select", keys: ["v"] },
  { id: "tool.text", group: "Tools", label: "Text (G3)", keys: ["t"] },
  { id: "tool.fill", group: "Tools", label: "Fill (G3)", keys: ["g"] },
  { id: "tool.eyedropper", group: "Tools", label: "Eyedropper (G3)", keys: ["i"] },

  { id: "edit.undo", group: "Edit", label: "Undo", keys: ["z"], meta: true, shift: false },
  { id: "edit.redo", group: "Edit", label: "Redo", keys: ["z"], meta: true, shift: true },
  { id: "edit.delete", group: "Edit", label: "Clear selection", keys: ["Delete", "Backspace"] },
  { id: "edit.cancel", group: "Edit", label: "Cancel gesture", keys: ["Escape"] },
  { id: "edit.copy", group: "Edit", label: "Copy selection", keys: ["c"], meta: true },
  { id: "edit.cut", group: "Edit", label: "Cut selection", keys: ["x"], meta: true },
  { id: "edit.paste", group: "Edit", label: "Paste (click to place)", keys: ["v"], meta: true },

  { id: "view.zoomIn", group: "View", label: "Zoom in", keys: ["+", "="] },
  { id: "view.zoomOut", group: "View", label: "Zoom out", keys: ["-", "_"] },
  { id: "view.zoomReset", group: "View", label: "Reset zoom", keys: ["0"] },
  { id: "view.toggleGrid", group: "View", label: "Toggle grid", keys: ["#"] },

  { id: "layer.next", group: "Layer", label: "Next layer", keys: ["]"] },
  { id: "layer.previous", group: "Layer", label: "Previous layer", keys: ["["] },
];

/** The shape `matchShortcut` needs — a subset of KeyboardEvent. */
export interface KeyDescriptor {
  readonly key: string;
  readonly mods: Modifiers;
}

/**
 * Every shortcut whose declared conditions match the keypress.
 *
 * Exported for the ambiguity test, which asserts this never returns more than one
 * entry. That property is what lets {@link matchShortcut} simply take the first
 * match instead of ranking candidates: undo/redo already disambiguate through the
 * Shift condition, so no tie-breaking is needed. A new shortcut that *did*
 * collide would fail that test rather than silently shadow an existing binding.
 */
export function matchingShortcuts(descriptor: KeyDescriptor): Shortcut[] {
  const { key, mods } = descriptor;
  const meta = mods.meta || mods.ctrl;
  const lower = key.toLowerCase();

  return SHORTCUTS.filter((shortcut) => {
    if (!shortcut.keys.some((k) => k.toLowerCase() === lower)) return false;
    if ((shortcut.meta ?? false) !== meta) return false;
    if (shortcut.shift !== undefined && shortcut.shift !== mods.shift) return false;
    return true;
  });
}

/** Resolves a keypress to a shortcut id, or `null`. */
export function matchShortcut(descriptor: KeyDescriptor): ShortcutId | null {
  return matchingShortcuts(descriptor)[0]?.id ?? null;
}

/** Grouped for the help panel, preserving declaration order within each group. */
export function shortcutsByGroup(): { group: ShortcutGroup; items: Shortcut[] }[] {
  const groups: ShortcutGroup[] = ["File", "Tools", "Edit", "View", "Layer"];
  return groups.map((group) => ({
    group,
    items: SHORTCUTS.filter((s) => s.group === group),
  }));
}

/** Display form, e.g. "⌘⇧Z". macOS-flavoured; G5 can platform-switch this. */
export function shortcutHint(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.meta === true) parts.push("⌘");
  if (shortcut.shift === true) parts.push("⇧");
  const key = shortcut.keys[0];
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("");
}
