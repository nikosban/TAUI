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

  it("falls back to memory after an advertised OPFS root rejects", async () => {
    const fallback: string[] = [];
    const statuses: unknown[] = [];
    setGlobals({
      navigator: {
        storage: { getDirectory: () => Promise.reject(new Error("private mode blocked it")) },
      },
      FileSystemDirectoryHandle: class {},
    });

    const store = createFileStore({
      picker: async () => "fallback.tui",
      onFallback: (message) => fallback.push(message),
      onStorageStatus: (status) => statuses.push(status),
    });
    expect(store.kind).toBe("opfs");

    const created = await store.saveAs("safe", "fallback.tui");
    expect(created).toMatchObject({
      handle: { key: "fallback.tui" },
    });
    await expect(store.openWithPicker()).resolves.toMatchObject({ content: "safe" });
    await expect(store.openHandle(created.handle)).resolves.toMatchObject({ content: "safe" });
    await expect(store.save(created.handle, "updated")).resolves.toMatchObject({
      modifiedAt: expect.any(Number),
    });
    await store.writeRecovery("untitled-fallback", "recovery");
    const [recovery] = await store.listRecoveries();
    expect(recovery?.content).toBe("recovery");
    await store.dropRecovery(recovery?.id ?? "");
    await store.writeRecovery("untitled-fallback", "other");
    await store.clearRecovery("untitled-fallback");
    await store.pushRecent(created.handle);
    expect((await store.listRecent())[0]?.handle.key).toBe("fallback.tui");
    await Promise.resolve();

    expect(store.kind).toBe("memory");
    expect(store.capabilities.persistent).toBe(false);
    expect(fallback).toEqual([
      "Browser storage is unavailable; this session will not survive a reload (private mode blocked it).",
    ]);
    expect(statuses).toEqual([
      { backend: "memory", persistence: "unavailable", usage: null, quota: null },
    ]);
  });

  it("routes calls through a successfully probed OPFS façade", async () => {
    const missing = new Error("missing");
    missing.name = "NotFoundError";
    const root = {
      getDirectoryHandle: async () => {
        throw missing;
      },
    };
    setGlobals({
      navigator: { storage: { getDirectory: () => Promise.resolve(root) } },
      FileSystemDirectoryHandle: class {},
    });

    const store = createFileStore({ picker });
    await expect(store.listRecent()).resolves.toEqual([]);
    expect(store.kind).toBe("opfs");
  });

  it("requests persistence and reports a finite quota after the root probe", async () => {
    const statuses: unknown[] = [];
    let persistCalls = 0;
    setGlobals({
      navigator: {
        storage: {
          getDirectory: () => Promise.resolve({}),
          persist: async () => {
            persistCalls += 1;
            return false;
          },
          estimate: async () => ({ usage: 1_024, quota: 8_192 }),
        },
      },
      FileSystemDirectoryHandle: class {},
    });

    createFileStore({ picker, onStorageStatus: (status) => statuses.push(status) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persistCalls).toBe(1);
    expect(statuses).toEqual([
      { backend: "opfs", persistence: "not-granted", usage: 1_024, quota: 8_192 },
    ]);
  });

  it("uses the persisted fallback and rejects invalid quota estimates", async () => {
    const statuses: unknown[] = [];
    setGlobals({
      navigator: {
        storage: {
          getDirectory: () => Promise.resolve({}),
          persisted: async () => true,
          estimate: async () => ({ usage: Number.POSITIVE_INFINITY, quota: -1 }),
        },
      },
      FileSystemDirectoryHandle: class {},
    });

    createFileStore({ picker, onStorageStatus: (status) => statuses.push(status) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statuses).toEqual([
      { backend: "opfs", persistence: "granted", usage: null, quota: null },
    ]);
  });

  it.each([
    ["persist", true, "granted"],
    ["persisted", false, "not-granted"],
  ] as const)("reports the %s result", async (method, result, expected) => {
    const statuses: unknown[] = [];
    setGlobals({
      navigator: {
        storage: {
          getDirectory: () => Promise.resolve({}),
          [method]: async () => result,
        },
      },
      FileSystemDirectoryHandle: class {},
    });
    createFileStore({ picker, onStorageStatus: (status) => statuses.push(status) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual([
      { backend: "opfs", persistence: expected, usage: null, quota: null },
    ]);
  });

  it.each([
    [new Error(" "), "access was rejected"],
    ["plain rejection", "plain rejection"],
    [null, "access was rejected"],
  ])("sanitises an OPFS probe rejection %p", async (rejection, message) => {
    const fallback: string[] = [];
    setGlobals({
      navigator: { storage: { getDirectory: () => Promise.reject(rejection) } },
      FileSystemDirectoryHandle: class {},
    });
    const store = createFileStore({
      picker: async () => "fallback.tui",
      onFallback: (reported) => fallback.push(reported),
    });
    await store.saveAs("safe", "fallback.tui");
    expect(fallback[0]).toContain(`(${message})`);
  });

  it("keeps working OPFS when persistence and estimate APIs reject", async () => {
    const statuses: unknown[] = [];
    setGlobals({
      navigator: {
        storage: {
          getDirectory: () => Promise.resolve({}),
          persist: () => Promise.reject(new Error("not allowed")),
          estimate: () => Promise.reject(new Error("hidden")),
        },
      },
      FileSystemDirectoryHandle: class {},
    });

    const store = createFileStore({ picker, onStorageStatus: (status) => statuses.push(status) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.kind).toBe("opfs");
    expect(statuses).toEqual([
      { backend: "opfs", persistence: "unavailable", usage: null, quota: null },
    ]);
  });
});
