/**
 * Backend selection.
 *
 * Small, but it is the module the "adding Tauri is a one-file change" claim rests
 * on, and its fallback is what stops a browser with broken storage from
 * presenting a blank screen.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createFileStore } from "../src/ports/index.js";

const picker = async () => null;

/**
 * The OPFS globals the availability probe reads.
 *
 * Assigned through a loosely-typed view of `globalThis`, since the point is to
 * simulate an environment that does not match the ambient types.
 */
interface Globals {
  navigator?: unknown;
  FileSystemDirectoryHandle?: unknown;
}

/**
 * Installs or removes the globals.
 *
 * `defineProperty` rather than assignment: in Node `globalThis.navigator` is a
 * getter-only accessor, so `globalThis.navigator = …` throws under ESM's strict
 * mode. Defining a configurable own property shadows it cleanly and `delete`
 * restores the original.
 */
const setGlobals = (over: Globals): void => {
  for (const name of ["navigator", "FileSystemDirectoryHandle"] as const) {
    const value = over[name];
    if (value === undefined) {
      delete (globalThis as unknown as Record<string, unknown>)[name];
      continue;
    }
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
};

const workingOpfs = (): Globals => ({
  navigator: { storage: { getDirectory: () => Promise.resolve({}) } },
  FileSystemDirectoryHandle: class {},
});

/** Installs just enough of the OPFS globals for the availability probe. */
function withOpfsGlobals(fn: () => void): void {
  setGlobals(workingOpfs());
  try {
    fn();
  } finally {
    setGlobals({});
  }
}

afterEach(() => setGlobals({}));

describe("createFileStore", () => {
  it("falls back to memory where OPFS is unavailable", () => {
    // The Vitest environment is `node`, so this is the real state of the world
    // here — no navigator at all.
    expect(createFileStore({ picker }).kind).toBe("memory");
  });

  it("chooses OPFS when the globals are present", () => {
    withOpfsGlobals(() => {
      expect(createFileStore({ picker }).kind).toBe("opfs");
    });
  });

  it("honours an explicit memory preference even where OPFS works", () => {
    // The `?store=memory` escape hatch: OPFS present but broken — a corrupt
    // origin, a browser in a strange private mode — still leaves a usable editor.
    withOpfsGlobals(() => {
      expect(createFileStore({ picker, prefer: "memory" }).kind).toBe("memory");
    });
  });

  it("honours an explicit OPFS preference where the probe would say no", () => {
    expect(createFileStore({ picker, prefer: "opfs" }).kind).toBe("opfs");
  });

  it("declines OPFS when the directory handle type is missing", () => {
    // Present-but-unusable: some sandboxed iframes expose `navigator.storage`
    // while the call rejects. Checking both is cheaper than a failed first save.
    setGlobals({ navigator: { storage: { getDirectory: () => Promise.resolve({}) } } });
    expect(createFileStore({ picker }).kind).toBe("memory");
  });

  it("declines OPFS when storage has no getDirectory", () => {
    setGlobals({ navigator: { storage: {} }, FileSystemDirectoryHandle: class {} });
    expect(createFileStore({ picker }).kind).toBe("memory");
  });

  it("declines OPFS when navigator has no storage at all", () => {
    setGlobals({ navigator: {}, FileSystemDirectoryHandle: class {} });
    expect(createFileStore({ picker }).kind).toBe("memory");
  });

  it("reports capabilities matching the backend it chose", () => {
    expect(createFileStore({ picker }).capabilities.persistent).toBe(false);
    withOpfsGlobals(() => {
      expect(createFileStore({ picker }).capabilities.persistent).toBe(true);
    });
  });
});
