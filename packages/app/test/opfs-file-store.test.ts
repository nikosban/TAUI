/**
 * The OPFS backend, against an in-memory fake of the File System Access API.
 *
 * A fake rather than a mock: it implements the directory/file semantics the
 * adapter actually relies on — create-on-demand, `lastModified`, recursive
 * remove, async iteration — so these tests exercise the adapter's real logic
 * instead of asserting on calls. That is what makes them able to catch the
 * sequencing and pruning bugs, which no call-assertion would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileStoreError,
  isCancelled,
  MAX_DOCUMENT_BYTES,
  type PickerFn,
  RECOVERY_HISTORY_LIMIT,
  RECOVERY_STARTUP_BYTES,
  RECOVERY_TOTAL_LIMIT,
} from "../src/ports/file-store.js";
import { createOpfsFileStore, type OpfsFileStore } from "../src/ports/opfs-file-store.js";

// ---- the fake ----

interface FakeFile {
  content: string;
  lastModified: number;
}

class NotFound extends Error {
  override name = "NotFoundError";
}

/** An in-memory directory implementing the members the adapter uses. */
class FakeDir {
  readonly kind = "directory" as const;
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Map<string, FakeDir>();
  failNextWrite = false;
  failNextAbort = false;
  getFileFailure: Error | null = null;
  aborts = 0;

  constructor(private readonly clock: () => number) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const found = this.dirs.get(name);
    if (found !== undefined) return found;
    if (opts?.create !== true) throw new NotFound(name);
    const created = new FakeDir(this.clock);
    this.dirs.set(name, created);
    return created;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (this.getFileFailure !== null) {
      const failure = this.getFileFailure;
      this.getFileFailure = null;
      throw failure;
    }
    if (!this.files.has(name)) {
      if (opts?.create !== true) throw new NotFound(name);
      this.files.set(name, { content: "", lastModified: this.clock() });
    }
    const dir = this;
    return {
      kind: "file" as const,
      async getFile() {
        const file = dir.files.get(name);
        if (file === undefined) throw new NotFound(name);
        return {
          text: async () => file.content,
          lastModified: file.lastModified,
          size: file.content.length,
        };
      },
      async createWritable() {
        let buffer = "";
        return {
          write: async (chunk: string) => {
            if (dir.failNextWrite) {
              dir.failNextWrite = false;
              throw new Error("write failed");
            }
            buffer += chunk;
          },
          close: async () => {
            dir.files.set(name, { content: buffer, lastModified: dir.clock() });
          },
          abort: async () => {
            dir.aborts++;
            if (dir.failNextAbort) {
              dir.failNextAbort = false;
              throw new Error("abort failed");
            }
          },
        };
      },
    };
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    if (this.dirs.has(name)) {
      const target = this.dirs.get(name) as FakeDir;
      if (opts?.recursive !== true && (target.files.size > 0 || target.dirs.size > 0)) {
        throw new Error("InvalidModificationError");
      }
      this.dirs.delete(name);
      return;
    }
    throw new NotFound(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.files.keys()) yield name;
    for (const name of this.dirs.keys()) yield name;
  }

  async *entries(): AsyncIterableIterator<[string, FakeDir | { kind: "file" }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" as const }];
    for (const [name, dir] of this.dirs) yield [name, dir];
  }
}

// ---- harness ----

let clock: number;
let root: FakeDir;
let store: OpfsFileStore;

const now = () => ++clock;
const pickerFor =
  (choice: string | null): PickerFn =>
  async () =>
    choice;

function makeStore(picker: PickerFn = pickerFor("a.tui")): OpfsFileStore {
  return createOpfsFileStore({
    picker,
    now,
    root: async () => root as unknown as FileSystemDirectoryHandle,
  });
}

const handle = (key: string) => ({ key, label: key, display: key });

/** Reads the raw snapshot filenames for a document, sorted. */
const snapshotNames = (key: string): string[] =>
  [...(root.dirs.get("recovery")?.dirs.get(key)?.files.keys() ?? [])].sort();

const snapshotNamesIn = (directory: FakeDir): string[] =>
  [...directory.files.keys()].filter((name) => /^\d{6}\.json$/u.test(name));

beforeEach(() => {
  clock = 1000;
  root = new FakeDir(now);
  store = makeStore();
});

afterEach(() => vi.unstubAllGlobals());

describe("capabilities", () => {
  it("declares itself persistent, with mtimes and no native dialogs", () => {
    expect(store.kind).toBe("opfs");
    expect(store.capabilities).toEqual({
      nativeDialogs: false,
      persistent: true,
      modifiedTimes: true,
    });
  });
});

describe("save and open", () => {
  it("round-trips a document", async () => {
    await store.save(handle("a.tui"), "hello");
    const opened = await store.openHandle(handle("a.tui"));
    expect(opened.content).toBe("hello");
    expect(opened.modifiedAt).not.toBeNull();
  });

  it("survives a fresh store over the same root, which is the whole point", async () => {
    await store.save(handle("a.tui"), "persisted");
    // A new adapter instance, as after a page reload.
    const reopened = await makeStore().openHandle(handle("a.tui"));
    expect(reopened.content).toBe("persisted");
  });

  it("overwrites rather than appending", async () => {
    await store.save(handle("a.tui"), "first");
    await store.save(handle("a.tui"), "second");
    expect((await store.openHandle(handle("a.tui"))).content).toBe("second");
  });

  it("reports a missing document as not-found", async () => {
    await expect(store.openHandle(handle("ghost.tui"))).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("rejects an oversized document before reading its text", async () => {
    const docs = await root.getDirectoryHandle("docs", { create: true });
    docs.files.set("huge.tui", {
      content: "x".repeat(MAX_DOCUMENT_BYTES + 1),
      lastModified: now(),
    });
    await expect(store.openHandle(handle("huge.tui"))).rejects.toThrow(/document size limit/u);
  });

  it("advances the modification time on save", async () => {
    const first = await store.save(handle("a.tui"), "v1");
    const second = await store.save(handle("a.tui"), "v2");
    expect(second.modifiedAt).toBeGreaterThan(first.modifiedAt ?? 0);
  });

  it("detects an mtime conflict before replacing newer bytes", async () => {
    const first = await store.save(handle("a.tui"), "v1");
    await store.save(handle("a.tui"), "external", { force: true });
    await expect(
      store.save(handle("a.tui"), "stale", { expectedModifiedAt: first.modifiedAt }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await store.openHandle(handle("a.tui"))).content).toBe("external");
  });

  it("aborts a writable stream after a write failure", async () => {
    await store.save(handle("a.tui"), "original");
    const docs = root.dirs.get("docs") as FakeDir;
    docs.failNextWrite = true;
    await expect(store.save(handle("a.tui"), "replacement")).rejects.toMatchObject({ code: "io" });
    expect(docs.aborts).toBe(1);
    expect((await store.openHandle(handle("a.tui"))).content).toBe("original");
  });

  it("preserves the write failure when abort cleanup also fails", async () => {
    await store.save(handle("a.tui"), "original");
    const docs = root.dirs.get("docs") as FakeDir;
    docs.failNextWrite = true;
    docs.failNextAbort = true;
    await expect(store.save(handle("a.tui"), "replacement")).rejects.toMatchObject({ code: "io" });
    expect(docs.aborts).toBe(1);
  });

  it("serializes the compare-and-write window through Web Locks when available", async () => {
    const requested: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async <T>(name: string, work: () => Promise<T>) => {
          requested.push(name);
          return work();
        },
      },
    });
    await store.save(handle("locked.tui"), "body");
    expect(requested).toEqual(["taui:opfs:locked.tui"]);
  });

  it("propagates a non-missing conflict preflight failure", async () => {
    await store.save(handle("a.tui"), "original");
    const docs = root.dirs.get("docs") as FakeDir;
    docs.getFileFailure = new Error("stat failed");
    await expect(
      store.save(handle("a.tui"), "replacement", { expectedModifiedAt: 1 }),
    ).rejects.toMatchObject({
      code: "io",
      cause: expect.objectContaining({ message: "stat failed" }),
    });
  });

  it("keeps legacy keys opaque but never exposes control or bidi text in labels", async () => {
    const key = "legacy\u202Egnp.tui";
    await store.save(handle(key), "body");
    const opened = await store.openHandle(handle(key));
    expect(opened.handle.key).toBe(key);
    expect(opened.handle.label).toBe("legacygnp.tui");
    expect(opened.handle.display).not.toContain("\u202E");
    await store.pushRecent(handle(key));
    expect((await store.listRecent())[0]?.handle.label).toBe("legacygnp.tui");
  });
});

describe("the picker", () => {
  it("opens the document the picker chose", async () => {
    await store.save(handle("chosen.tui"), "content");
    const picked = makeStore(pickerFor("chosen.tui"));
    expect((await picked.openWithPicker()).content).toBe("content");
  });

  it("offers the documents that exist", async () => {
    await store.save(handle("b.tui"), "x");
    await store.save(handle("a.tui"), "y");
    let offered: readonly { key: string }[] = [];
    const spy = makeStore(async (entries) => {
      offered = entries;
      return "a.tui";
    });
    await spy.openWithPicker();
    expect(offered.map((e) => e.key)).toEqual(["a.tui", "b.tui"]);
  });

  it("treats a dismissed picker as cancelled, not as a failure", async () => {
    const cancelling = makeStore(pickerFor(null));
    await expect(cancelling.openWithPicker()).rejects.toSatisfy(isCancelled);
    await expect(cancelling.saveAs("x", "y.tui")).rejects.toSatisfy(isCancelled);
  });

  it("appends .tui when the typed name omits it", async () => {
    const saving = makeStore(pickerFor("no-extension"));
    const { handle: created } = await saving.saveAs("body", "suggested.tui");
    expect(created.key).toBe("no-extension.tui");
    expect((await saving.openHandle(created)).content).toBe("body");
  });

  it("accepts a handle from the picker, not just a typed name", async () => {
    // The port lets a picker return either; a list-based dialog returns the handle
    // it was given rather than re-typing its key.
    await store.save(handle("existing.tui"), "body");
    const byHandle = makeStore(async (entries) => entries[0] ?? null);
    expect((await byHandle.openWithPicker()).content).toBe("body");

    const savingByHandle = makeStore(async (entries) => ({
      handle: entries[0] ?? "existing.tui",
      overwrite: true,
    }));
    const { handle: created } = await savingByHandle.saveAs("new body", "s.tui");
    expect(created.key).toBe("existing.tui");
  });

  it("accepts an explicit picker choice when opening", async () => {
    await store.save(handle("existing.tui"), "body");
    const picked = makeStore(async (entries) => ({
      handle: entries[0] ?? "existing.tui",
      overwrite: false,
    }));
    expect((await picked.openWithPicker()).content).toBe("body");
  });

  it("refuses Save As over an existing name without explicit overwrite intent", async () => {
    await store.save(handle("existing.tui"), "original");
    const createOnly = makeStore(pickerFor("existing.tui"));
    await expect(createOnly.saveAs("replacement", "existing.tui")).rejects.toMatchObject({
      code: "already-exists",
    });
    expect((await store.openHandle(handle("existing.tui"))).content).toBe("original");
  });

  it("keeps a name that already ends in .tui", async () => {
    const saving = makeStore(pickerFor("named.tui"));
    expect((await saving.saveAs("body", "s.tui")).handle.key).toBe("named.tui");
  });

  it("applies the canonical safe document name before touching OPFS", async () => {
    let suggested = "";
    const safe = makeStore(async (_entries, _mode, name) => {
      suggested = name ?? "";
      return "../report\u202Egnp";
    });
    const { handle: created } = await safe.saveAs("body", "draft");
    expect(suggested).toBe("draft.tui");
    expect(created.key).toBe("-reportgnp.tui");
    expect((await safe.openHandle(created)).content).toBe("body");
  });
});

describe("recovery history", () => {
  it("appends one file per snapshot, zero-padded so they sort", async () => {
    for (const content of ["v1", "v2", "v3"]) {
      await store.writeRecovery("a.tui", content);
    }
    expect(snapshotNames("a.tui")).toEqual(["000001.json", "000002.json", "000003.json"]);
  });

  it("keeps every snapshot reachable, newest first", async () => {
    for (const content of ["oldest", "middle", "newest"]) {
      await store.writeRecovery("a.tui", content);
    }
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("prunes the oldest once the limit is reached", async () => {
    for (let i = 0; i < RECOVERY_HISTORY_LIMIT + 3; i++) {
      await store.writeRecovery("a.tui", `v${i}`);
    }
    expect(snapshotNames("a.tui")).toHaveLength(RECOVERY_HISTORY_LIMIT);
    const contents = (await store.listRecoveries()).map((r) => r.content);
    expect(contents[0]).toBe(`v${RECOVERY_HISTORY_LIMIT + 2}`);
    // The first three were dropped.
    expect(contents).not.toContain("v0");
  });

  it("keeps sequencing past the pruning point, so names never collide", async () => {
    // The bug this guards: sequencing from `history.length` instead of from the
    // highest existing name would restart at 1 after a prune and overwrite a
    // surviving snapshot.
    for (let i = 0; i < RECOVERY_HISTORY_LIMIT + 5; i++) {
      await store.writeRecovery("a.tui", `v${i}`);
    }
    const names = snapshotNames("a.tui");
    expect(new Set(names).size).toBe(names.length);
    expect(names.at(-1)).toBe(`${String(RECOVERY_HISTORY_LIMIT + 5).padStart(6, "0")}.json`);
  });

  it("ignores malformed filenames when choosing the next sequence", async () => {
    const recovery = await root.getDirectoryHandle("recovery", { create: true });
    const directory = await recovery.getDirectoryHandle("a.tui", { create: true });
    directory.files.set("NaN.json", { content: "junk", lastModified: now() });
    directory.files.set("999999999999.json", { content: "junk", lastModified: now() });

    await store.writeRecovery("a.tui", "valid");
    expect(snapshotNames("a.tui")).toContain("000001.json");
    expect((await store.listRecoveries()).map((entry) => entry.content)).toEqual(["valid"]);
  });

  it("wraps recovery sequence numbers after the six-digit ceiling", async () => {
    const recovery = await root.getDirectoryHandle("recovery", { create: true });
    const directory = await recovery.getDirectoryHandle("a.tui", { create: true });
    directory.files.set("000001.json", { content: "old", lastModified: now() });
    directory.files.set("999999.json", { content: "last", lastModified: now() });

    await store.writeRecovery("a.tui", "wrapped");
    expect(snapshotNames("a.tui")).toContain("000002.json");
  });

  it("rejects a recovery payload over the document byte limit", async () => {
    await expect(store.writeRecovery("a.tui", "x".repeat(MAX_DOCUMENT_BYTES))).rejects.toThrow(
      /size limit/u,
    );
  });

  it("uses filenames to break equal-age pruning ties deterministically", async () => {
    const recovery = await root.getDirectoryHandle("recovery", { create: true });
    const directory = await recovery.getDirectoryHandle("a.tui", { create: true });
    for (let index = 1; index <= RECOVERY_HISTORY_LIMIT; index++) {
      directory.files.set(`${String(index).padStart(6, "0")}.json`, {
        content: JSON.stringify({ content: `${index}`, savedAt: index }),
        lastModified: 42,
      });
    }
    await store.writeRecovery("a.tui", "newest");
    expect(snapshotNames("a.tui")).toHaveLength(RECOVERY_HISTORY_LIMIT);
    expect((await store.listRecoveries())[0]?.content).toBe("newest");
  });

  it("bounds recovery count across documents, not only within one history", async () => {
    for (let document = 0; document < 6; document++) {
      for (let snapshot = 0; snapshot < RECOVERY_HISTORY_LIMIT; snapshot++) {
        await store.writeRecovery(`doc-${document}.tui`, `${document}:${snapshot}`);
      }
    }
    const count = [...(root.dirs.get("recovery")?.dirs.values() ?? [])].reduce(
      (sum, directory) => sum + snapshotNamesIn(directory).length,
      0,
    );
    expect(count).toBeLessThanOrEqual(RECOVERY_TOTAL_LIMIT);
    expect(await store.listRecoveries()).toHaveLength(RECOVERY_TOTAL_LIMIT);
  });

  it("offers snapshots for a document that was never saved", async () => {
    await store.writeRecovery("untitled-1", "work in progress");
    const found = await store.listRecoveries();
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceModifiedAt).toBeNull();
  });

  it("offers a missing document recovery even when another document directory exists", async () => {
    await store.save(handle("other.tui"), "saved");
    await store.writeRecovery("missing.tui", "work in progress");
    expect((await store.listRecoveries()).map((entry) => entry.content)).toEqual([
      "work in progress",
    ]);
  });

  it("skips recoveries beyond the startup byte budget", async () => {
    const recovery = await root.getDirectoryHandle("recovery", { create: true });
    const directory = await recovery.getDirectoryHandle("large.tui", { create: true });
    directory.files.set("000001.json", {
      content: "x".repeat(RECOVERY_STARTUP_BYTES + 1),
      lastModified: now(),
    });
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("contains a recovery stat race to the affected snapshot", async () => {
    await store.writeRecovery("a.tui", "safe");
    const directory = root.dirs.get("recovery")?.dirs.get("a.tui") as FakeDir;
    directory.getFileFailure = new NotFound("removed between list and stat");
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("hides the whole history once the document is saved cleanly", async () => {
    await store.writeRecovery("a.tui", "edit1");
    await store.writeRecovery("a.tui", "edit2");
    await store.save(handle("a.tui"), "saved");
    // Every snapshot predates the save.
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("still offers a snapshot taken after the last save", async () => {
    await store.save(handle("a.tui"), "saved");
    await store.writeRecovery("a.tui", "edited since");
    const found = await store.listRecoveries();
    expect(found.map((r) => r.content)).toEqual(["edited since"]);
    expect(found[0]?.sourceModifiedAt).not.toBeNull();
  });

  it("clears every snapshot for a document", async () => {
    await store.writeRecovery("a.tui", "x");
    await store.writeRecovery("a.tui", "y");
    await store.clearRecovery("a.tui");
    expect(snapshotNames("a.tui")).toEqual([]);
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("treats clearing a document with no history as a no-op", async () => {
    await expect(store.clearRecovery("never-touched")).resolves.toBeUndefined();
  });

  it("treats a missing recovery under an existing parent as a no-op", async () => {
    await store.writeRecovery("other.tui", "x");
    await expect(store.clearRecovery("never-touched")).resolves.toBeUndefined();
  });

  it("drops one snapshot, leaving the rest", async () => {
    for (const content of ["v1", "v2", "v3"]) {
      await store.writeRecovery("a.tui", content);
    }
    const middle = (await store.listRecoveries()).find((r) => r.content === "v2");
    await store.dropRecovery(middle?.id ?? "");
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["v3", "v1"]);
  });

  it("removes the document's directory once its last snapshot is dropped", async () => {
    await store.writeRecovery("a.tui", "only");
    const [entry] = await store.listRecoveries();
    await store.dropRecovery(entry?.id ?? "");
    // An empty directory would otherwise be walked on every listRecoveries.
    expect(root.dirs.get("recovery")?.dirs.has("a.tui")).toBe(false);
  });

  it("ignores dropping an id that no longer exists", async () => {
    await store.writeRecovery("a.tui", "x");
    await expect(store.dropRecovery("a.tui/999999.json")).resolves.toBeUndefined();
    expect(snapshotNames("a.tui")).toHaveLength(1);
  });

  it("ignores a malformed id rather than throwing", async () => {
    // The bug this caught once: an id whose separator did not match what
    // listRecoveries mints made every drop silently no-op.
    await expect(store.dropRecovery("no-separator")).resolves.toBeUndefined();
    await expect(store.dropRecovery("/leading")).resolves.toBeUndefined();
  });

  it("mints ids that dropRecovery can actually parse", async () => {
    // The two halves must agree. Asserting the format directly would not catch a
    // mismatch; round-tripping a real id does.
    await store.writeRecovery("a.tui", "x");
    const [entry] = await store.listRecoveries();
    expect(entry?.id).toBe("a.tui/000001.json");
    await store.dropRecovery(entry?.id ?? "");
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("interleaves documents newest-first", async () => {
    await store.writeRecovery("a.tui", "a1");
    await store.writeRecovery("b.tui", "b1");
    await store.writeRecovery("a.tui", "a2");
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["a2", "b1", "a1"]);
  });

  it("skips a torn snapshot but keeps the rest of the history", async () => {
    // The failure mode a per-file layout exists to contain: a crash mid-write
    // leaves one unparseable file, and the other snapshots must still be offered.
    await store.writeRecovery("a.tui", "good1");
    await store.writeRecovery("a.tui", "good2");
    const dir = root.dirs.get("recovery")?.dirs.get("a.tui");
    dir?.files.set("000002.json", { content: '{"content":"trunc', lastModified: now() });

    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["good1"]);
  });

  it("skips a snapshot whose shape is wrong", async () => {
    await store.writeRecovery("a.tui", "good");
    const dir = root.dirs.get("recovery")?.dirs.get("a.tui");
    dir?.files.set("000002.json", {
      content: '{"content":42,"savedAt":"soon"}',
      lastModified: now(),
    });
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["good"]);
  });

  it("ignores a stray file sitting directly in the recovery directory", async () => {
    // Storage is hand-editable; a loose file there is not a document's history and
    // must not be treated as one.
    await store.writeRecovery("a.tui", "real");
    const recovery = await root.getDirectoryHandle("recovery", { create: true });
    recovery.files.set("stray.txt", { content: "junk", lastModified: now() });

    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["real"]);
  });

  it("returns nothing when no document has any history", async () => {
    expect(await store.listRecoveries()).toEqual([]);
  });
});

describe("non-creating read and delete paths", () => {
  it("leaves a fresh OPFS root empty", async () => {
    await expect(store.listRecent()).resolves.toEqual([]);
    await expect(store.listRecoveries()).resolves.toEqual([]);
    await expect(store.clearRecovery("missing.tui")).resolves.toBeUndefined();
    await expect(store.dropRecovery("missing.tui/000001.json")).resolves.toBeUndefined();
    await expect(store.openHandle(handle("missing.tui"))).rejects.toMatchObject({
      code: "not-found",
    });
    expect([...root.dirs.keys()]).toEqual([]);
  });
});

describe("recent files", () => {
  it("lists most-recent first and survives a fresh store", async () => {
    for (const key of ["a.tui", "b.tui", "c.tui"]) {
      await store.pushRecent(handle(key));
    }
    expect((await makeStore().listRecent()).map((r) => r.handle.key)).toEqual([
      "c.tui",
      "b.tui",
      "a.tui",
    ]);
  });

  it("moves an existing entry to the front rather than duplicating it", async () => {
    for (const key of ["a.tui", "b.tui", "a.tui"]) {
      await store.pushRecent(handle(key));
    }
    const recent = await store.listRecent();
    expect(recent.map((r) => r.handle.key)).toEqual(["a.tui", "b.tui"]);
  });

  it("caps the list", async () => {
    for (let i = 0; i < 20; i++) await store.pushRecent(handle(`doc${i}.tui`));
    expect((await store.listRecent()).length).toBeLessThanOrEqual(12);
  });

  it("starts empty", async () => {
    expect(await store.listRecent()).toEqual([]);
  });

  it("recovers from a corrupt recent list instead of blocking the app", async () => {
    // Storage is hand-editable and a bad recent list must never stop you opening
    // a document.
    const meta = await root.getDirectoryHandle("meta", { create: true });
    meta.files.set("recent.json", { content: "{not json", lastModified: now() });
    expect(await store.listRecent()).toEqual([]);
  });

  it("drops entries of the wrong shape but keeps the good ones", async () => {
    const meta = await root.getDirectoryHandle("meta", { create: true });
    meta.files.set("recent.json", {
      content: JSON.stringify([
        { handle: { key: "ok.tui", label: "ok", display: "ok" }, openedAt: 5 },
        { nonsense: true },
        { handle: { key: 42 }, openedAt: "later" },
      ]),
      lastModified: now(),
    });
    expect((await store.listRecent()).map((r) => r.handle.key)).toEqual(["ok.tui"]);
  });

  it("ignores a recent list that is not an array", async () => {
    const meta = await root.getDirectoryHandle("meta", { create: true });
    meta.files.set("recent.json", { content: '{"a":1}', lastModified: now() });
    expect(await store.listRecent()).toEqual([]);
  });
});

describe("error mapping", () => {
  it("passes a FileStoreError through unchanged rather than re-wrapping it", async () => {
    const failing = createOpfsFileStore({
      picker: pickerFor("a.tui"),
      now,
      root: async () => {
        throw new FileStoreError("permission-denied", "storage blocked");
      },
    });
    await expect(failing.openHandle(handle("a.tui"))).rejects.toMatchObject({
      code: "permission-denied",
      message: "storage blocked",
    });
  });

  it("maps a permission failure to permission-denied", async () => {
    const failing = createOpfsFileStore({
      picker: pickerFor("a.tui"),
      now,
      root: async () => {
        const error = new Error("nope");
        error.name = "NotAllowedError";
        throw error;
      },
    });
    await expect(failing.openHandle(handle("a.tui"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("maps anything else to io", async () => {
    const failing = createOpfsFileStore({
      picker: pickerFor("a.tui"),
      now,
      root: async () => {
        throw new Error("disk on fire");
      },
    });
    await expect(failing.save(handle("a.tui"), "x")).rejects.toMatchObject({ code: "io" });
    await expect(failing.writeRecovery("a.tui", "x")).rejects.toMatchObject({ code: "io" });
    await expect(failing.pushRecent(handle("a.tui"))).rejects.toMatchObject({ code: "io" });
    await expect(failing.clearRecovery("a.tui")).rejects.toMatchObject({ code: "io" });
    await expect(failing.dropRecovery("a.tui/000001.json")).rejects.toMatchObject({
      code: "io",
    });
  });
});
