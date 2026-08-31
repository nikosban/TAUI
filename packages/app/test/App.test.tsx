// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_COLOR, deserialize, drawText, toText } from "@tui-designer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealCommit } from "../src/gestures/commit.js";
import type { DocHandle, FileStore } from "../src/ports/file-store.js";
import { SHORTCUTS, shortcutsByGroup } from "../src/shortcuts.js";
import { createDocumentStore } from "../src/stores/document-store.js";
import { useToolStore } from "../src/stores/tool-store.js";
import { templateById } from "../src/templates.js";
import {
  installComponentBrowserShell,
  memoryStore,
  renderApp,
  resetComponentStores,
} from "./component-harness.js";

const STYLE = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR } as const;

beforeEach(() => {
  resetComponentStores();
  installComponentBrowserShell();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App component boundary", () => {
  it("opens generated searchable command help with current availability", async () => {
    const { user } = renderApp();
    const trigger = screen.getByRole("button", { name: "Keyboard shortcuts (⌘/)" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const search = within(dialog).getByRole("searchbox", { name: "Search commands" });
    expect(document.activeElement).toBe(search);
    expect(within(dialog).getByText(`${SHORTCUTS.length} commands`)).toBeTruthy();
    expect(
      [...dialog.querySelectorAll(".shortcut-command strong")].map((node) => node.textContent),
    ).toEqual(shortcutsByGroup().flatMap(({ items }) => items.map(({ label }) => label)));
    expect(within(dialog).getByText("Save")).toBeTruthy();
    expect(within(dialog).getByText("Rename focused layer")).toBeTruthy();
    expect(within(dialog).getAllByText("Currently unavailable:").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Nothing to undo.")).toBeTruthy();

    await user.type(search, "layer");
    expect(within(dialog).getByText("5 commands")).toBeTruthy();
    expect(within(dialog).queryByText("Save")).toBeNull();
    expect(within(dialog).getByText("Move focused layer up")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses non-macOS labels and toggles help from its global chord", async () => {
    renderApp({ platform: "Win32" });
    const trigger = screen.getByRole("button", { name: "Keyboard shortcuts (Ctrl+/)" });
    expect(trigger.textContent).toContain("Ctrl+/");

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getAllByText("Ctrl+S").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Ctrl+Shift+S")).toBeTruthy();

    const search = within(dialog).getByRole("searchbox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "/", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("injects clipboard behavior without reading the browser clipboard global", async () => {
    useToolStore.setState({ selection: { top: 0, left: 0, rows: 2, cols: 3 } });
    const { user, writeClipboard } = renderApp();

    await user.click(screen.getByRole("button", { name: "copy" }));

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledOnce());
    expect(writeClipboard.mock.calls[0]?.[0]).toContain('"rows": 2');
    expect(screen.getByText("Measurements copied as JSON.")).toBeTruthy();
  });

  it("guards dirty template replacement and beforeunload through injected confirmation", async () => {
    const initial = templateById("dashboard").build();
    const documentStore = createDocumentStore(initial);
    const confirm = vi.fn(() => false);
    const { user } = renderApp({ documentStore, confirm });
    const template = screen.getByRole("combobox", { name: /template/u });

    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    act(() => {
      documentStore
        .getState()
        .commit(sealCommit(drawText(initial, initial.activeLayerId, 0, 0, "changed", STYLE)));
    });
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);

    await user.selectOptions(template, "form");
    expect(confirm).toHaveBeenCalledOnce();
    expect(toText(documentStore.getState().present())).toContain("changed");
    expect(toText(documentStore.getState().present())).not.toContain("new connection");
    expect((template as HTMLSelectElement).value).toBe("dashboard");

    confirm.mockReturnValue(true);
    await user.selectOptions(template, "form");
    expect(toText(documentStore.getState().present())).toContain("new connection");
    expect(documentStore.getState().dirty).toBe(false);
  });

  it("keeps later edits dirty when a delayed save completes", async () => {
    const initial = templateById("empty").build();
    const handle: DocHandle = { key: "saved.tui", label: "saved.tui", display: "saved.tui" };
    const documentStore = createDocumentStore(initial);
    documentStore.getState().load(initial, handle, 1);
    const firstEdit = drawText(initial, initial.activeLayerId, 0, 0, "one", STYLE);
    documentStore.getState().commit(sealCommit(firstEdit));

    let finishSave: ((result: { modifiedAt: number | null }) => void) | null = null;
    const base = memoryStore();
    const delayed: FileStore = {
      ...base,
      save: () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    };
    renderApp({ documentStore, fileStore: delayed });

    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await screen.findByText("file: save…");

    act(() => {
      const secondEdit = drawText(firstEdit, firstEdit.activeLayerId, 1, 0, "two", STYLE);
      documentStore.getState().commit(sealCommit(secondEdit));
    });
    act(() => finishSave?.({ modifiedAt: 2 }));

    await waitFor(() => expect(screen.queryByText("file: save…")).toBeNull());
    expect(documentStore.getState().dirty).toBe(true);
    expect(documentStore.getState().modifiedAt).toBe(2);
    expect(screen.getByText("● unsaved")).toBeTruthy();
  });

  it("focuses Save As and marks the exact saved revision clean on completion", async () => {
    const initial = templateById("empty").build();
    const documentStore = createDocumentStore(initial);
    documentStore
      .getState()
      .commit(sealCommit(drawText(initial, initial.activeLayerId, 0, 0, "save me", STYLE)));
    const { user, memoryFileStore } = renderApp({ documentStore });
    if (memoryFileStore === null) throw new Error("Harness did not create its memory store");

    fireEvent.keyDown(window, { key: "s", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Save as" });
    const input = within(dialog).getByRole("textbox", { name: "File name" });
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, "component-test");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(documentStore.getState().dirty).toBe(false));
    expect(documentStore.getState().handle?.label).toBe("component-test.tui");
    const saved = memoryFileStore.snapshot()["component-test.tui"];
    expect(toText(deserialize(saved ?? "").doc)).toContain("save me");
    expect(screen.getByText("○ saved")).toBeTruthy();
  });

  it("wires footer undo and redo to the document history", async () => {
    const initial = templateById("empty").build();
    const changed = drawText(initial, initial.activeLayerId, 0, 0, "history", STYLE);
    const documentStore = createDocumentStore(initial);
    documentStore.getState().commit(sealCommit(changed));
    const { user } = renderApp({ documentStore });
    const undo = screen.getByRole("button", { name: "undo" });
    const redo = screen.getByRole("button", { name: "redo" });

    expect((undo as HTMLButtonElement).disabled).toBe(false);
    await user.click(undo);
    expect(toText(documentStore.getState().present())).not.toContain("history");
    expect((redo as HTMLButtonElement).disabled).toBe(false);

    await user.click(redo);
    expect(toText(documentStore.getState().present())).toContain("history");
  });

  it("keeps recovery modal priority and leaves it open after a failed restore", async () => {
    const store = memoryStore({ now: () => 90_000 });
    await store.writeRecovery("untitled-90000-1", "{ not valid json");
    const { user } = renderApp({ fileStore: store, now: vi.fn(() => 100_000) });

    const recovery = await screen.findByRole("dialog", { name: "Recover unsaved work" });
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });
    expect(screen.getAllByRole("dialog")).toEqual([recovery]);
    expect(screen.queryByRole("dialog", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Save as" })).toBeNull();

    await user.click(within(recovery).getByTitle("untitled-90000-1.tui (in memory)"));
    await screen.findByText("That recovery snapshot is unreadable.");
    expect(screen.getByRole("dialog", { name: "Recover unsaved work" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Recover unsaved work" })).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
