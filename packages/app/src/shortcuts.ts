/**
 * One registry for every application command with a keyboard binding.
 *
 * Global handlers and focused panel handlers both resolve through this table, so
 * the command-help dialog, visible hints, and conflict checks cannot drift from
 * the behavior they describe.
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
  | "view.pan"
  | "layer.next"
  | "layer.previous"
  | "layer.rename"
  | "layer.moveUp"
  | "layer.moveDown"
  | "palette.rename"
  | "help.shortcuts";

export type ShortcutGroup = "File" | "Tools" | "Edit" | "View" | "Layer" | "Palette" | "Help";
export type ShortcutScope = "global" | "layer-list" | "palette-list";
export type ShortcutPlatform = "mac" | "other";

export interface Shortcut {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  readonly label: string;
  /** Where focus must be for the binding to apply. */
  readonly context: string;
  /** Why the command can be unavailable, generated beside its current state. */
  readonly unavailableWhen: string;
  readonly scope: ShortcutScope;
  /** `event.key` values, compared case-insensitively. */
  readonly keys: readonly [string, ...string[]];
  /** Require Cmd/Ctrl. Default false. */
  readonly meta?: boolean;
  /** Require Shift. When omitted, Shift is ignored rather than forbidden. */
  readonly shift?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "file.save",
    group: "File",
    label: "Save",
    context: "Editor",
    unavailableWhen: "A file operation is already running.",
    scope: "global",
    keys: ["s"],
    meta: true,
    shift: false,
  },
  {
    id: "file.saveAs",
    group: "File",
    label: "Save as",
    context: "Editor",
    unavailableWhen: "A file operation is already running.",
    scope: "global",
    keys: ["s"],
    meta: true,
    shift: true,
  },
  {
    id: "file.open",
    group: "File",
    label: "Open",
    context: "Editor",
    unavailableWhen: "A file operation is already running.",
    scope: "global",
    keys: ["o"],
    meta: true,
  },
  {
    id: "file.export",
    group: "File",
    label: "Export",
    context: "Editor",
    unavailableWhen: "A file operation or dialog is already open.",
    scope: "global",
    keys: ["e"],
    meta: true,
  },

  ...(
    [
      ["tool.pencil", "Pencil", "p"],
      ["tool.box", "Box", "b"],
      ["tool.line", "Line", "l"],
      ["tool.select", "Select", "v"],
      ["tool.text", "Text", "t"],
      ["tool.fill", "Fill", "g"],
      ["tool.eyedropper", "Eyedropper", "i"],
    ] as const
  ).map(
    ([id, label, key]): Shortcut => ({
      id,
      group: "Tools",
      label,
      context: "Canvas",
      unavailableWhen: "Text editing or a dialog owns the keyboard.",
      scope: "global",
      keys: [key],
    }),
  ),
  {
    id: "view.pan",
    group: "View",
    label: "Pan canvas (hold and drag)",
    context: "Canvas",
    unavailableWhen: "Text editing or a dialog owns the keyboard.",
    scope: "global",
    keys: [" "],
  },

  {
    id: "edit.undo",
    group: "Edit",
    label: "Undo",
    context: "Editor",
    unavailableWhen: "There is no earlier document state.",
    scope: "global",
    keys: ["z"],
    meta: true,
    shift: false,
  },
  {
    id: "edit.redo",
    group: "Edit",
    label: "Redo",
    context: "Editor",
    unavailableWhen: "There is no later document state.",
    scope: "global",
    keys: ["z"],
    meta: true,
    shift: true,
  },
  {
    id: "edit.delete",
    group: "Edit",
    label: "Clear selection",
    context: "Canvas selection",
    unavailableWhen: "No region is selected or text is being edited.",
    scope: "global",
    keys: ["Delete", "Backspace"],
  },
  {
    id: "edit.cancel",
    group: "Edit",
    label: "Cancel current action",
    context: "Editor",
    unavailableWhen: "There is no gesture, text edit, selection, paste, or dialog to cancel.",
    scope: "global",
    keys: ["Escape"],
  },
  {
    id: "edit.copy",
    group: "Edit",
    label: "Copy selection",
    context: "Canvas selection",
    unavailableWhen: "No region is selected.",
    scope: "global",
    keys: ["c"],
    meta: true,
  },
  {
    id: "edit.cut",
    group: "Edit",
    label: "Cut selection",
    context: "Canvas selection",
    unavailableWhen: "No region is selected.",
    scope: "global",
    keys: ["x"],
    meta: true,
  },
  {
    id: "edit.paste",
    group: "Edit",
    label: "Paste and place",
    context: "Canvas",
    unavailableWhen: "The internal clipboard is empty.",
    scope: "global",
    keys: ["v"],
    meta: true,
  },

  ...(
    [
      ["view.zoomIn", "Zoom in", ["+", "="]],
      ["view.zoomOut", "Zoom out", ["-", "_"]],
      ["view.zoomReset", "Reset zoom", ["0"]],
      ["view.toggleGrid", "Toggle grid", ["#"]],
    ] as const
  ).map(
    ([id, label, keys]): Shortcut => ({
      id,
      group: "View",
      label,
      context: "Canvas",
      unavailableWhen: "A dialog owns the keyboard.",
      scope: "global",
      keys,
    }),
  ),

  {
    id: "layer.next",
    group: "Layer",
    label: "Next layer",
    context: "Editor",
    unavailableWhen: "The document has only one layer or a dialog is open.",
    scope: "global",
    keys: ["]"],
  },
  {
    id: "layer.previous",
    group: "Layer",
    label: "Previous layer",
    context: "Editor",
    unavailableWhen: "The document has only one layer or a dialog is open.",
    scope: "global",
    keys: ["["],
  },
  {
    id: "layer.rename",
    group: "Layer",
    label: "Rename focused layer",
    context: "Focused layer",
    unavailableWhen: "A layer name is not focused.",
    scope: "layer-list",
    keys: ["F2"],
  },
  {
    id: "layer.moveUp",
    group: "Layer",
    label: "Move focused layer up",
    context: "Focused layer",
    unavailableWhen: "The top layer is focused.",
    scope: "layer-list",
    keys: ["ArrowUp"],
  },
  {
    id: "layer.moveDown",
    group: "Layer",
    label: "Move focused layer down",
    context: "Focused layer",
    unavailableWhen: "The bottom layer is focused.",
    scope: "layer-list",
    keys: ["ArrowDown"],
  },
  {
    id: "palette.rename",
    group: "Palette",
    label: "Rename focused colour",
    context: "Focused palette colour",
    unavailableWhen: "A palette colour name is not focused.",
    scope: "palette-list",
    keys: ["F2"],
  },
  {
    id: "help.shortcuts",
    group: "Help",
    label: "Keyboard shortcuts",
    context: "Editor",
    unavailableWhen: "Another dialog owns the keyboard.",
    scope: "global",
    keys: ["/"],
    meta: true,
  },
];

/** The shape shortcut matching needs — a subset of KeyboardEvent. */
export interface KeyDescriptor {
  readonly key: string;
  readonly mods: Modifiers;
}

const matches = (shortcut: Shortcut, descriptor: KeyDescriptor): boolean => {
  const { key, mods } = descriptor;
  const meta = mods.meta || mods.ctrl;
  const lower = key.toLowerCase();
  if (!shortcut.keys.some((candidate) => candidate.toLowerCase() === lower)) return false;
  if ((shortcut.meta ?? false) !== meta) return false;
  if (shortcut.shift !== undefined && shortcut.shift !== mods.shift) return false;
  return true;
};

/** Every shortcut whose declared scope and conditions match the keypress. */
export function matchingShortcuts(
  descriptor: KeyDescriptor,
  scope: ShortcutScope = "global",
): Shortcut[] {
  return SHORTCUTS.filter((shortcut) => shortcut.scope === scope && matches(shortcut, descriptor));
}

/** Resolves a keypress to a shortcut id, or `null`. */
export function matchShortcut(
  descriptor: KeyDescriptor,
  scope: ShortcutScope = "global",
): ShortcutId | null {
  return matchingShortcuts(descriptor, scope)[0]?.id ?? null;
}

/** Grouped for generated command help, preserving registry order. */
export function shortcutsByGroup(): { group: ShortcutGroup; items: Shortcut[] }[] {
  const groups: ShortcutGroup[] = ["File", "Tools", "Edit", "View", "Layer", "Palette", "Help"];
  return groups
    .map((group) => ({ group, items: SHORTCUTS.filter((shortcut) => shortcut.group === group) }))
    .filter(({ items }) => items.length > 0);
}

const displayKey = (key: string): string => {
  const names: Readonly<Record<string, string>> = {
    ArrowDown: "↓",
    ArrowUp: "↑",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Esc",
    " ": "Space",
  };
  return names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
};

/** Display forms for every accepted key, such as `⌘Z` or `Ctrl+Z`. */
export function shortcutHints(shortcut: Shortcut, platform: ShortcutPlatform): string[] {
  return shortcut.keys.map((key) => {
    if (platform === "mac") {
      return `${shortcut.meta === true ? "⌘" : ""}${shortcut.shift === true ? "⇧" : ""}${displayKey(key)}`;
    }
    const modifiers = [
      ...(shortcut.meta === true ? ["Ctrl"] : []),
      ...(shortcut.shift === true ? ["Shift"] : []),
    ];
    return [...modifiers, displayKey(key)].join("+");
  });
}

/** Compact display form used by tooltips and toolbar keys. */
export function shortcutHint(shortcut: Shortcut, platform: ShortcutPlatform = "mac"): string {
  return shortcutHints(shortcut, platform)[0] ?? "";
}

export function shortcutPlatform(platform: string): ShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "mac" : "other";
}

export interface ShortcutConflict {
  readonly scope: ShortcutScope;
  readonly key: string;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly ids: readonly ShortcutId[];
}

/**
 * Exhaustively finds ambiguous bindings in each focus scope.
 *
 * A shortcut whose Shift requirement is omitted intentionally matches both Shift
 * states, so comparing registry rows directly would miss real overlaps. Sweeping
 * the actual matcher keeps this check identical to runtime behavior.
 */
export function shortcutConflicts(): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  const scopes = new Set(SHORTCUTS.map((shortcut) => shortcut.scope));
  for (const scope of scopes) {
    const keys = new Set(
      SHORTCUTS.filter((shortcut) => shortcut.scope === scope).flatMap((shortcut) =>
        shortcut.keys.map((key) => key.toLowerCase()),
      ),
    );
    for (const key of keys) {
      for (const meta of [false, true]) {
        for (const shift of [false, true]) {
          const found = SHORTCUTS.filter(
            (shortcut) =>
              shortcut.scope === scope &&
              matches(shortcut, {
                key,
                mods: { alt: false, ctrl: false, meta, shift },
              }),
          );
          if (found.length > 1) {
            conflicts.push({ scope, key, meta, shift, ids: found.map(({ id }) => id) });
          }
        }
      }
    }
  }
  return conflicts;
}
