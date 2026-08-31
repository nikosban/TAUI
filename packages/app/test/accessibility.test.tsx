// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installComponentBrowserShell,
  memoryStore,
  renderApp,
  resetComponentStores,
} from "./component-harness.js";

async function expectNoAccessibilityViolations(): Promise<void> {
  const result = await axe.run(document.body);
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

beforeEach(() => {
  resetComponentStores();
  installComponentBrowserShell();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("accessible component boundary", () => {
  it("keeps every primary editor panel free of automated accessibility violations", async () => {
    renderApp();

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "Terminal document canvas" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Inspector and document controls" }),
    ).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Document status and history" })).toBeTruthy();
    await expectNoAccessibilityViolations();
  });

  it("checks the Open, Save as, Export, and Recovery dialogs", async () => {
    const { user, fileStore } = renderApp({ now: vi.fn(() => 100_000) });
    await fileStore.save(
      { key: "available.tui", label: "available.tui", display: "available.tui" },
      "document",
    );

    fireEvent.keyDown(window, { key: "o", metaKey: true });
    const open = await screen.findByRole("dialog", { name: "Open" });
    await expectNoAccessibilityViolations();
    await user.click(within(open).getByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });
    const save = await screen.findByRole("dialog", { name: "Save as" });
    await expectNoAccessibilityViolations();
    await user.click(within(save).getByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "e", metaKey: true });
    const exportDialog = await screen.findByRole("dialog", { name: "Export" });
    await expectNoAccessibilityViolations();
    await user.click(within(exportDialog).getByRole("button", { name: "Cancel" }));

    cleanup();
    const recoveryStore = memoryStore({ now: () => 90_000 });
    await recoveryStore.writeRecovery("untitled-90000-1", "snapshot");
    renderApp({ fileStore: recoveryStore, now: vi.fn(() => 100_000) });
    await screen.findByRole("dialog", { name: "Recover unsaved work" });
    await expectNoAccessibilityViolations();
  });

  it("traps modal focus, makes the editor inert, closes on Escape, and restores focus", async () => {
    const { user } = renderApp();
    const trigger = screen.getByRole("combobox", { name: "template" });
    trigger.focus();

    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Save as" });
    const input = within(dialog).getByRole("textbox", { name: "File name" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(input);

    const app = dialog.closest(".app");
    expect(
      [...(app?.children ?? [])]
        .filter((element) => !element.classList.contains("modal-backdrop"))
        .every((element) => (element as HTMLElement).inert),
    ).toBe(true);

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("supports keyboard layer reordering and rename entry", async () => {
    const { user } = renderApp();
    const layers = screen.getByRole("region", { name: "Layers" });
    await user.click(within(layers).getByRole("button", { name: "+ add" }));

    const before = screen.getAllByRole("button", { name: /layer \d+ of \d+/u });
    const firstName = before[0]?.getAttribute("aria-label")?.split(",")[0];
    before[0]?.focus();
    await user.keyboard("{ArrowDown}");
    const after = screen.getAllByRole("button", { name: /layer \d+ of \d+/u });
    expect(after[1]?.getAttribute("aria-label")?.startsWith(firstName ?? "")).toBe(true);

    after[1]?.focus();
    await user.keyboard("{F2}");
    expect(
      screen.getByRole("textbox", { name: new RegExp(`Rename ${firstName}`, "u") }),
    ).toBeTruthy();
  });
});
