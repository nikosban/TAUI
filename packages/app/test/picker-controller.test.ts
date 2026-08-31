/** Promise ownership for the browser-backed file picker. */

import { describe, expect, it } from "vitest";
import { createPickerController, type PickerRequest } from "../src/files/FileDialogs.js";

const HANDLE = { key: "a.tui", label: "a.tui", display: "a.tui (browser storage)" };

describe("picker controller", () => {
  it("rejects a re-entrant request without orphaning the active promise", async () => {
    let visible: PickerRequest | null = null;
    const published: Array<PickerRequest | null> = [];
    const controller = createPickerController((request) => {
      visible = request;
      published.push(request);
    });

    const first = controller.picker([HANDLE], "open");
    const owned = visible;
    expect(owned).not.toBeNull();

    const second = controller.picker([HANDLE], "save", "other.tui");
    expect(await second).toBeNull();
    expect(visible).toBe(owned);

    (owned as PickerRequest | null)?.resolve(HANDLE);
    expect(await first).toEqual(HANDLE);
    expect(visible).toBeNull();
    expect(published).toEqual([owned, null]);
  });

  it("settles the pending promise as cancelled when its owner unmounts", async () => {
    let visible: PickerRequest | null = null;
    const controller = createPickerController((request) => {
      visible = request;
    });
    const pending = controller.picker([], "open");
    expect(visible).not.toBeNull();

    controller.cancelPending();

    expect(await pending).toBeNull();
    expect(visible).toBeNull();
  });

  it("ignores a stale resolver after its request has settled", async () => {
    let visible: PickerRequest | null = null;
    const controller = createPickerController((request) => {
      visible = request;
    });
    const pending = controller.picker([], "save", "first.tui");
    const owned = visible;
    (owned as PickerRequest | null)?.resolve("first.tui");
    expect(await pending).toBe("first.tui");

    (owned as PickerRequest | null)?.resolve("stale.tui");
    expect(visible).toBeNull();
  });
});
