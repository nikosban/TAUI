import { beforeEach, describe, expect, it } from "vitest";
import {
  FileStoreError,
  isCancelled,
  type PickerFn,
  RECOVERY_HISTORY_LIMIT,
} from "../src/ports/file-store.js";
import { createMemoryFileStore, type MemoryFileStore } from "../src/ports/memory-file-store.js";

let clock: number;
const now = () => ++clock;

beforeEach(() => {
  clock = 0;
});

/** Always picks the given name, or cancels when null. */
const pickerFor =
  (choice: string | null): PickerFn =>
  async () =>
    choice;

describe("capabilities", () => {
  it("declares itself non-persistent with no native dialogs", () => {
    const store = createMemoryFileStore({ now });
    expect(store.kind).toBe("memory");
    expect(store.capabilities).toEqual({
      nativeDialogs: false,
      persistent: false,
      modifiedTimes: true,
    });
  });
});

describe("open and save", () => {
  let store: MemoryFileStore;

  beforeEach(() => {
    store = createMemoryFileStore({
      now,
      picker: pickerFor("a.tui"),
      initial: { "a.tui": "content-a", "b.tui": "content-b" },
    });
  });

  it("opens a seeded document through the picker", async () => {
    const result = await store.openWithPicker();
    expect(result.content).toBe("content-a");
    expect(result.handle.key).toBe("a.tui");
    expect(result.handle.display).toContain("in memory");
    expect(result.modifiedAt).not.toBeNull();
  });

  it("opens a known handle directly", async () => {
    const result = await store.openHandle({ key: "b.tui", label: "b.tui", display: "b.tui" });
    expect(result.content).toBe("content-b");
  });

  it("keeps legacy keys opaque but never exposes control or bidi text in labels", async () => {
    const key = "legacy\u202Egnp.tui";
    const legacy = createMemoryFileStore({ now, initial: { [key]: "body" } });
    const opened = await legacy.openHandle({ key, label: key, display: key });
    expect(opened.handle.key).toBe(key);
    expect(opened.handle.label).toBe("legacygnp.tui");
    expect(opened.handle.display).not.toContain("\u202E");
    await legacy.pushRecent({ key, label: key, display: key });
    expect((await legacy.listRecent())[0]?.handle.label).toBe("legacygnp.tui");
  });

  it("saves over an existing handle and advances the mtime", async () => {
    const before = (await store.openHandle({ key: "a.tui", label: "a", display: "a" })).modifiedAt;
    const { modifiedAt } = await store.save({ key: "a.tui", label: "a", display: "a" }, "updated");
    expect(store.snapshot()["a.tui"]).toBe("updated");
    expect(modifiedAt).toBeGreaterThan(before ?? 0);
  });

  it("saveAs writes to the chosen name and returns the new handle", async () => {
    const fresh = createMemoryFileStore({ now, picker: pickerFor("new.tui") });
    const { handle } = await fresh.saveAs("hello", "untitled.tui");
    expect(handle.key).toBe("new.tui");
    expect(fresh.snapshot()).toEqual({ "new.tui": "hello" });
  });

  it("applies the canonical safe document name to picker strings", async () => {
    let suggested = "";
    const safe = createMemoryFileStore({
      now,
      picker: async (_entries, _mode, name) => {
        suggested = name ?? "";
        return "../report\u202Egnp";
      },
    });
    const { handle } = await safe.saveAs("body", "draft");
    expect(suggested).toBe("draft.tui");
    expect(handle.key).toBe("-reportgnp.tui");
    expect(safe.snapshot()).toEqual({ "-reportgnp.tui": "body" });
  });

  it("accepts a DocHandle from the picker, not just a name", async () => {
    // The picker contract allows either: an existing handle (open) or a new name
    // (save-as). Both paths must work.
    const byHandle = createMemoryFileStore({
      now,
      initial: { "a.tui": "content-a" },
      picker: async (entries) => entries[0] ?? null,
    });
    const opened = await byHandle.openWithPicker();
    expect(opened.handle.key).toBe("a.tui");
    expect(opened.content).toBe("content-a");

    const saved = await byHandle.saveAs("overwritten", "ignored.tui");
    expect(saved.handle.key).toBe("a.tui");
    expect(byHandle.snapshot()["a.tui"]).toBe("overwritten");
  });

  it("reports a missing document as not-found", async () => {
    await expect(store.openHandle({ key: "ghost.tui", label: "g", display: "g" })).rejects.toThrow(
      FileStoreError,
    );
    await expect(store.openHandle({ key: "ghost.tui", label: "g", display: "g" })).rejects.toThrow(
      /no such document/u,
    );
  });
});

describe("cancellation", () => {
  it("throws a recognisable cancelled error rather than returning null", async () => {
    // One catch handles it and the happy path stays unbranched.
    const store = createMemoryFileStore({ now, picker: pickerFor(null) });
    await expect(store.openWithPicker()).rejects.toThrow(FileStoreError);
    try {
      await store.openWithPicker();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isCancelled(e)).toBe(true);
    }
  });

  it("distinguishes cancellation from other failures", async () => {
    const store = createMemoryFileStore({ now, picker: pickerFor("nope.tui") });
    try {
      await store.openWithPicker();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isCancelled(e)).toBe(false);
      expect((e as FileStoreError).code).toBe("not-found");
    }
  });

  it("cancels saveAs too", async () => {
    const store = createMemoryFileStore({ now, picker: pickerFor(null) });
    await expect(store.saveAs("x", "untitled.tui")).rejects.toSatisfy(isCancelled);
  });

  it("reports unsupported when no picker is configured", async () => {
    const store = createMemoryFileStore({ now });
    await expect(store.openWithPicker()).rejects.toThrow(/no picker configured/u);
    try {
      await store.saveAs("x", "y.tui");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as FileStoreError).code).toBe("unsupported");
    }
  });
});

describe("recovery", () => {
  it("offers a recovery blob newer than its source", async () => {
    const store = createMemoryFileStore({ now, initial: { "a.tui": "saved" } });
    await store.writeRecovery("a.tui", "unsaved-edits");
    const found = await store.listRecoveries();
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("unsaved-edits");
    expect(found[0]?.sourceModifiedAt).not.toBeNull();
  });

  it("does not offer a recovery older than a clean save", async () => {
    // The exact sequence after a normal save: the blob is stale and must not
    // prompt the user.
    const store = createMemoryFileStore({ now, initial: { "a.tui": "v1" } });
    await store.writeRecovery("a.tui", "mid-edit");
    await store.save({ key: "a.tui", label: "a", display: "a" }, "v2");
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("offers a recovery whose source never existed — an unsaved document", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("untitled-123", "work in progress");
    const found = await store.listRecoveries();
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceModifiedAt).toBeNull();
  });

  it("clears every snapshot for a document", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("k", "x");
    await store.writeRecovery("k", "y");
    expect(store.recoverySnapshot()).toEqual({ k: ["x", "y"] });
    await store.clearRecovery("k");
    expect(await store.listRecoveries()).toEqual([]);
  });

  it("ignores clearing a blob that is not there", async () => {
    const store = createMemoryFileStore({ now });
    await expect(store.clearRecovery("absent")).resolves.toBeUndefined();
  });
});

describe("recovery history", () => {
  it("appends rather than overwriting, so an earlier state stays reachable", async () => {
    // The point of a history: if the newest autosave caught a bad state — a layer
    // cleared by accident — the one before it is still there.
    const store = createMemoryFileStore({ now });
    for (const content of ["v1", "v2", "v3"]) {
      await store.writeRecovery("k", content);
    }
    expect(store.recoverySnapshot()).toEqual({ k: ["v1", "v2", "v3"] });
  });

  it("lists newest first, per the port contract", async () => {
    const store = createMemoryFileStore({ now });
    for (const content of ["oldest", "middle", "newest"]) {
      await store.writeRecovery("k", content);
    }
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("prunes the oldest once the limit is reached", async () => {
    const store = createMemoryFileStore({ now });
    for (let i = 0; i < RECOVERY_HISTORY_LIMIT + 4; i++) {
      await store.writeRecovery("k", `v${i}`);
    }
    const history = store.recoverySnapshot().k ?? [];
    expect(history).toHaveLength(RECOVERY_HISTORY_LIMIT);
    // The first four are gone; the newest survives.
    expect(history[0]).toBe("v4");
    expect(history.at(-1)).toBe(`v${RECOVERY_HISTORY_LIMIT + 3}`);
  });

  it("gives every snapshot a distinct id, across documents too", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("a", "1");
    await store.writeRecovery("a", "2");
    await store.writeRecovery("b", "3");
    const ids = (await store.listRecoveries()).map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("drops one snapshot, leaving the rest", async () => {
    const store = createMemoryFileStore({ now });
    for (const content of ["v1", "v2", "v3"]) {
      await store.writeRecovery("k", content);
    }
    const middle = (await store.listRecoveries()).find((r) => r.content === "v2");
    await store.dropRecovery(middle?.id ?? "");
    expect(store.recoverySnapshot()).toEqual({ k: ["v1", "v3"] });
  });

  it("forgets the document entirely once its last snapshot is dropped", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("k", "only");
    const [entry] = await store.listRecoveries();
    await store.dropRecovery(entry?.id ?? "");
    // An empty history would otherwise be iterated forever.
    expect(store.recoverySnapshot()).toEqual({});
  });

  it("ignores dropping an id that is not there", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("k", "x");
    await expect(store.dropRecovery("nope")).resolves.toBeUndefined();
    expect(store.recoverySnapshot()).toEqual({ k: ["x"] });
  });

  it("interleaves documents newest-first when several have snapshots", async () => {
    const store = createMemoryFileStore({ now });
    await store.writeRecovery("a", "a1");
    await store.writeRecovery("b", "b1");
    await store.writeRecovery("a", "a2");
    // Sorted by time across documents, so the prompt can lead with the newest.
    expect((await store.listRecoveries()).map((r) => r.content)).toEqual(["a2", "b1", "a1"]);
  });

  it("hides a document's whole history once it is saved cleanly", async () => {
    const store = createMemoryFileStore({ now, initial: { "a.tui": "v1" } });
    await store.writeRecovery("a.tui", "edit1");
    await store.writeRecovery("a.tui", "edit2");
    await store.save({ key: "a.tui", label: "a", display: "a" }, "v2");
    // Every snapshot predates the save, so none is worth offering.
    expect(await store.listRecoveries()).toEqual([]);
  });
});

describe("recent files", () => {
  it("lists most-recent first", async () => {
    const store = createMemoryFileStore({ now });
    for (const key of ["a", "b", "c"]) {
      await store.pushRecent({ key, label: key, display: key });
    }
    expect((await store.listRecent()).map((r) => r.handle.key)).toEqual(["c", "b", "a"]);
  });

  it("moves an existing entry to the front rather than duplicating it", async () => {
    const store = createMemoryFileStore({ now });
    for (const key of ["a", "b", "a"]) {
      await store.pushRecent({ key, label: key, display: key });
    }
    const recent = await store.listRecent();
    expect(recent.map((r) => r.handle.key)).toEqual(["a", "b"]);
    expect(recent).toHaveLength(2);
  });

  it("starts empty", async () => {
    expect(await createMemoryFileStore({ now }).listRecent()).toEqual([]);
  });
});

describe("as a test double", () => {
  it("round-trips arbitrary serialized content untouched", async () => {
    // The port speaks strings; serialize/deserialize stay in core. So the adapter
    // must be byte-faithful, including trailing newlines.
    const store = createMemoryFileStore({ now, picker: pickerFor("doc.tui") });
    const content = '{\n  "version": 1\n}\n';
    await store.saveAs(content, "doc.tui");
    const back = await store.openHandle({ key: "doc.tui", label: "d", display: "d" });
    expect(back.content).toBe(content);
  });

  it("uses an injectable clock so no test needs fake timers", async () => {
    const store = createMemoryFileStore({ now: () => 42 });
    const { modifiedAt } = await store.save({ key: "k", label: "k", display: "k" }, "x");
    expect(modifiedAt).toBe(42);
  });

  it("provides its own default clock when none is injected", async () => {
    const store = createMemoryFileStore();
    const first = await store.save({ key: "k", label: "k", display: "k" }, "a");
    const second = await store.save({ key: "k", label: "k", display: "k" }, "b");
    expect(second.modifiedAt).toBeGreaterThan(first.modifiedAt ?? 0);
  });
});
