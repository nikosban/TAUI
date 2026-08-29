/**
 * Save, open, and autosave sequencing.
 *
 * Driven against the real `MemoryFileStore` rather than a mock, so the assertions
 * are about observable state — what is on "disk", what history remains — instead
 * of which methods were called. The ordering claims (recovery cleared only after a
 * successful write; autosave state not advanced on failure) are only meaningful
 * that way.
 */

import type { TuiDocument } from "@tui-designer/core";
import {
  createDocument,
  deserialize,
  drawText,
  sequentialIdGen,
  serialize,
  toText,
} from "@tui-designer/core";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTOSAVE_INTERVAL_MS } from "../src/ports/autosave.js";
import { createFileActions, type FileActions } from "../src/ports/file-actions.js";
import type { DocHandle, FileStore, PickerFn, RecoveryInfo } from "../src/ports/file-store.js";
import { FileStoreError } from "../src/ports/file-store.js";
import { createMemoryFileStore, type MemoryFileStore } from "../src/ports/memory-file-store.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

const docWith = (text: string): TuiDocument => {
  const base = createDocument(20, 3, { idGen: sequentialIdGen() });
  return drawText(base, base.activeLayerId, 0, 0, text, STYLE);
};

let store: MemoryFileStore;
let actions: FileActions;
let clock: number;
let notices: string[];
/** Mirrors what the document store would hold. */
let state: {
  doc: TuiDocument;
  handle: DocHandle | null;
  dirty: boolean;
  revision: number;
  busy: boolean;
};

function build(opts: { picker?: PickerFn; store?: FileStore } = {}): FileActions {
  return createFileActions({
    store: opts.store ?? store,
    snapshot: () => state,
    load: (doc, handle, opts) => {
      state = {
        ...state,
        doc,
        handle,
        dirty: opts?.dirty === true,
        revision: state.revision + 1,
      };
    },
    markSaved: (handle) => {
      state = { ...state, handle, dirty: false };
    },
    now: () => clock,
    notify: (message) => notices.push(message),
  });
}

/** Text of a document as stored under `key`; serialize keeps chars per-cell. */
const storedText = (key: string): string => toText(deserialize(store.snapshot()[key] ?? "").doc);

/** Text of a recovery snapshot's content. */
const snapshotText = (info: { content: string }): string => toText(deserialize(info.content).doc);

/** Advances the clock and edits the document, as a real edit would. */
function edit(text: string, advanceMs = AUTOSAVE_INTERVAL_MS): void {
  clock += advanceMs;
  state = { ...state, doc: docWith(text), dirty: true, revision: state.revision + 1 };
}

beforeEach(() => {
  clock = 1_000_000;
  notices = [];
  store = createMemoryFileStore({ picker: async () => "a.tui", now: () => clock });
  state = { doc: docWith("start"), handle: null, dirty: false, revision: 0, busy: false };
  actions = build();
});

describe("save", () => {
  it("falls back to Save As when the document has no handle", async () => {
    state = { ...state, dirty: true };
    expect(await actions.save()).toBe(true);
    expect(state.handle?.key).toBe("a.tui");
    expect(storedText("a.tui")).toContain("start");
  });

  it("writes to the existing handle on a second save", async () => {
    await actions.save();
    edit("changed");
    expect(await actions.save()).toBe(true);
    // Same handle, new content — not a second file.
    expect(Object.keys(store.snapshot())).toEqual(["a.tui"]);
    expect(storedText("a.tui")).toContain("changed");
  });

  it("marks the document saved and pushes it to recent", async () => {
    await actions.save();
    expect(state.dirty).toBe(false);
    expect((await store.listRecent()).map((r) => r.handle.key)).toEqual(["a.tui"]);
  });

  it("clears the recovery history once the save succeeds", async () => {
    // The snapshots exist to survive a crash; once the real file holds the same
    // content they are noise that would prompt on every launch.
    edit("work");
    await actions.tick();
    expect(Object.keys(store.recoverySnapshot())).toHaveLength(1);

    await actions.save();
    expect(await actions.listRecoveries()).toEqual([]);
  });

  it("keeps the recovery history when the save fails", async () => {
    // The inverse, and the one that matters: if the write failed, the snapshots
    // are the only copy of the work.
    edit("precious");
    await actions.tick();

    const failing: FileStore = {
      ...store,
      save: async () => {
        throw new FileStoreError("io", "disk full");
      },
    };
    const withFailure = build({ store: failing });
    state = { ...state, handle: { key: "a.tui", label: "a", display: "a" } };

    expect(await withFailure.save()).toBe(false);
    expect(notices.join()).toContain("disk full");
    // Untouched.
    expect(Object.keys(store.recoverySnapshot())).toHaveLength(1);
  });

  it("reports a cancelled Save As as unsuccessful but says nothing", async () => {
    const cancelling = build({
      store: createMemoryFileStore({ picker: async () => null, now: () => clock }),
    });
    expect(await cancelling.saveAs()).toBe(false);
    // Cancelling is a choice, not an error worth a message.
    expect(notices).toEqual([]);
  });

  it("reports a Save As that failed for a real reason", async () => {
    const failing: FileStore = {
      ...store,
      saveAs: async () => {
        throw new FileStoreError("io", "no space left");
      },
    };
    expect(await build({ store: failing }).saveAs()).toBe(false);
    expect(notices.join()).toContain("no space left");
  });

  it("stays quiet when a backend cancels a plain save", async () => {
    // Not reachable through OPFS, but a Tauri save may raise its own dialog and be
    // dismissed; cancelling must not surface as an error.
    const cancelling: FileStore = {
      ...store,
      save: async () => {
        throw new FileStoreError("cancelled", "user dismissed");
      },
    };
    state = { ...state, handle: { key: "a.tui", label: "a", display: "a" } };
    expect(await build({ store: cancelling }).save()).toBe(false);
    expect(notices).toEqual([]);
  });

  it("suggests the current filename when saving as", async () => {
    await actions.save();
    let suggested: string | undefined;
    const spy = build({
      store: createMemoryFileStore({
        picker: async (_entries, _mode, name) => {
          suggested = name;
          return "b.tui";
        },
        now: () => clock,
      }),
    });
    await spy.saveAs();
    expect(suggested).toBe("a.tui");
  });

  it("suggests untitled.tui for a document that was never saved", async () => {
    let suggested: string | undefined;
    const spy = build({
      store: createMemoryFileStore({
        picker: async (_entries, _mode, name) => {
          suggested = name;
          return "new.tui";
        },
        now: () => clock,
      }),
    });
    await spy.saveAs();
    expect(suggested).toBe("untitled.tui");
  });
});

describe("open", () => {
  it("loads a document and clears the dirty flag", async () => {
    await store.save(
      { key: "saved.tui", label: "saved.tui", display: "x" },
      serialize(docWith("from disk")),
    );
    const opening = build({
      store: createMemoryFileStore({
        picker: async () => "saved.tui",
        now: () => clock,
        initial: { "saved.tui": serialize(docWith("from disk")) },
      }),
    });

    expect(await opening.open()).toBe(true);
    expect(toText(state.doc)).toContain("from disk");
    expect(state.dirty).toBe(false);
    expect(state.handle?.key).toBe("saved.tui");
  });

  it("refuses a file that is not a readable document, without wiping the current one", async () => {
    const opening = build({
      store: createMemoryFileStore({
        picker: async () => "junk.tui",
        now: () => clock,
        initial: { "junk.tui": "{ not json" },
      }),
    });
    const before = state.doc;
    expect(await opening.open()).toBe(false);
    expect(notices.join()).toContain("not a readable .tui document");
    expect(state.doc).toBe(before);
  });

  it("surfaces deserialize warnings but still opens the file", async () => {
    // The format repairs rather than rejects; the repair must be reported.
    const raw = JSON.parse(serialize(docWith("kept")));
    raw.activeLayerId = "missing";
    const opening = build({
      store: createMemoryFileStore({
        picker: async () => "repaired.tui",
        now: () => clock,
        initial: { "repaired.tui": JSON.stringify(raw) },
      }),
    });

    expect(await opening.open()).toBe(true);
    expect(notices.join()).toContain("repaired.tui:");
    expect(toText(state.doc)).toContain("kept");
  });

  it("reports an open that failed for a real reason", async () => {
    const failing: FileStore = {
      ...store,
      openWithPicker: async () => {
        throw new FileStoreError("io", "unreadable volume");
      },
    };
    expect(await build({ store: failing }).open()).toBe(false);
    expect(notices.join()).toContain("unreadable volume");
  });

  it("opens a known handle directly, skipping the picker", async () => {
    // The recent-files path: the handle is already known, so no dialog is needed.
    const direct = build({
      store: createMemoryFileStore({
        picker: async () => null,
        now: () => clock,
        initial: { "recent.tui": serialize(docWith("from recents")) },
      }),
    });
    expect(await direct.openHandle({ key: "recent.tui", label: "recent.tui", display: "r" })).toBe(
      true,
    );
    expect(toText(state.doc)).toContain("from recents");
  });

  it("stays quiet when opening a handle is cancelled", async () => {
    const cancelling: FileStore = {
      ...store,
      openHandle: async () => {
        throw new FileStoreError("cancelled", "dismissed");
      },
    };
    expect(
      await build({ store: cancelling }).openHandle({ key: "x", label: "x", display: "x" }),
    ).toBe(false);
    expect(notices).toEqual([]);
  });

  it("reports a cancelled open quietly", async () => {
    const cancelling = build({
      store: createMemoryFileStore({ picker: async () => null, now: () => clock }),
    });
    expect(await cancelling.open()).toBe(false);
    expect(notices).toEqual([]);
  });

  it("reports a missing file by name", async () => {
    expect(await actions.openHandle({ key: "ghost.tui", label: "ghost.tui", display: "g" })).toBe(
      false,
    );
    expect(notices.join()).toContain("ghost.tui");
  });

  it("does not autosave the document it just opened", async () => {
    // Opening resets the autosave baseline, so a freshly opened clean file cannot
    // immediately write a snapshot identical to itself.
    const opening = build({
      store: createMemoryFileStore({
        picker: async () => "s.tui",
        now: () => clock,
        initial: { "s.tui": serialize(docWith("disk")) },
      }),
    });
    await opening.open();
    clock += AUTOSAVE_INTERVAL_MS * 5;
    await opening.tick();
    expect(await opening.listRecoveries()).toEqual([]);
  });
});

describe("autosave", () => {
  it("writes a snapshot once an edit has settled", async () => {
    edit("typed something");
    await actions.tick();
    const found = await actions.listRecoveries();
    expect(found).toHaveLength(1);
    expect(snapshotText(found[0] as { content: string })).toContain("typed something");
  });

  it("uses one stable key for an unsaved document, building a history", async () => {
    // The bug this guards: keying on the clock per tick would scatter one snapshot
    // per key instead of accumulating a history under one.
    edit("v1");
    await actions.tick();
    edit("v2");
    await actions.tick();
    edit("v3");
    await actions.tick();

    const keys = Object.keys(store.recoverySnapshot());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^untitled-/u);
    expect(store.recoverySnapshot()[keys[0] as string]).toHaveLength(3);
  });

  it("switches to the document's own key once it is saved", async () => {
    edit("before save");
    await actions.tick();
    await actions.save();

    edit("after save");
    await actions.tick();
    expect(Object.keys(store.recoverySnapshot())).toEqual(["a.tui"]);
  });

  it("discards the untitled history when the document gets a real name", async () => {
    // Otherwise the untitled snapshots prompt for recovery forever, under a name
    // that means nothing to the user.
    edit("work");
    await actions.tick();
    const untitled = actions.autosaveKey();
    expect(untitled).toMatch(/^untitled-/u);

    await actions.save();
    expect(Object.keys(store.recoverySnapshot())).not.toContain(untitled);
  });

  it("skips while a gesture or typing burst is open", async () => {
    edit("half-drawn");
    state = { ...state, busy: true };
    await actions.tick();
    expect(await actions.listRecoveries()).toEqual([]);

    state = { ...state, busy: false };
    await actions.tick();
    expect(await actions.listRecoveries()).toHaveLength(1);
  });

  it("does nothing on a clean document however long it ticks", async () => {
    for (let i = 0; i < 5; i++) {
      clock += AUTOSAVE_INTERVAL_MS;
      await actions.tick();
    }
    expect(await actions.listRecoveries()).toEqual([]);
  });

  it("writes once per distinct state, not once per tick", async () => {
    edit("one");
    for (let i = 0; i < 4; i++) {
      clock += AUTOSAVE_INTERVAL_MS;
      await actions.tick();
    }
    expect(await actions.listRecoveries()).toHaveLength(1);
  });

  it("retries next tick when a write fails, rather than skipping the state for good", async () => {
    let fail = true;
    const flaky: FileStore = {
      ...store,
      writeRecovery: async (key, content) => {
        if (fail) throw new FileStoreError("io", "quota exceeded");
        await store.writeRecovery(key, content);
      },
    };
    const withFlake = build({ store: flaky });

    edit("important");
    await withFlake.tick();
    expect(notices.join()).toContain("quota exceeded");
    expect(await withFlake.listRecoveries()).toEqual([]);

    // Same revision, so only a non-advanced autosave state lets this through.
    fail = false;
    clock += AUTOSAVE_INTERVAL_MS;
    await withFlake.tick();
    expect(await withFlake.listRecoveries()).toHaveLength(1);
  });
});

describe("recovery", () => {
  /** Two snapshots under an unsaved key. */
  async function withHistory(): Promise<void> {
    edit("older");
    await actions.tick();
    edit("newer");
    await actions.tick();
  }

  it("offers snapshots newest first", async () => {
    await withHistory();
    const found = await actions.listRecoveries();
    expect(found).toHaveLength(2);
    expect(snapshotText(found[0] as { content: string })).toContain("newer");
    expect(snapshotText(found[1] as { content: string })).toContain("older");
  });

  it("restores a chosen snapshot as an UNSAVED document", async () => {
    // The snapshot is newer than the file, so adopting the handle and letting a
    // later save overwrite silently would destroy the last real save.
    await withHistory();
    const [newest] = await actions.listRecoveries();
    expect(await actions.restore(newest as RecoveryInfo)).toBe(true);

    expect(toText(state.doc)).toContain("newer");
    expect(state.handle).toBeNull();
    // Dirty, or the unload warning stays silent and the recovered work can be
    // lost a second time by closing the tab.
    expect(state.dirty).toBe(true);
    expect(notices.join()).toContain("Save to keep it");
  });

  it("can restore an older snapshot, which is the point of a history", async () => {
    await withHistory();
    const found = await actions.listRecoveries();
    await actions.restore(found[1] as RecoveryInfo);
    expect(toText(state.doc)).toContain("older");
  });

  it("refuses an unreadable snapshot without replacing the document", async () => {
    await withHistory();
    const found = await actions.listRecoveries();
    const before = state.doc;
    const corrupt: RecoveryInfo = { ...(found[0] as RecoveryInfo), content: "{ truncated" };
    expect(await actions.restore(corrupt)).toBe(false);
    expect(state.doc).toBe(before);
    expect(notices.join()).toContain("unreadable");
  });

  it("discards one snapshot, leaving the rest", async () => {
    await withHistory();
    const found = await actions.listRecoveries();
    await actions.discard(found[0] as RecoveryInfo);
    const left = await actions.listRecoveries();
    expect(left).toHaveLength(1);
    expect(snapshotText(left[0] as { content: string })).toContain("older");
  });

  it("discards everything, across documents", async () => {
    await withHistory();
    await actions.save();
    edit("more");
    await actions.tick();
    expect((await actions.listRecoveries()).length).toBeGreaterThan(0);

    await actions.discardAll();
    expect(await actions.listRecoveries()).toEqual([]);
  });

  it("survives a store that cannot read its recovery data", async () => {
    // A broken recovery directory must not stop the app starting.
    const broken: FileStore = {
      ...store,
      listRecoveries: async () => {
        throw new FileStoreError("io", "corrupt");
      },
    };
    const withBroken = build({ store: broken });
    expect(await withBroken.listRecoveries()).toEqual([]);
    expect(notices.join()).toContain("corrupt");
  });

  it("reports a failure to discard rather than throwing", async () => {
    await withHistory();
    const found = await actions.listRecoveries();
    const broken: FileStore = {
      ...store,
      dropRecovery: async () => {
        throw new FileStoreError("io", "locked");
      },
    };
    await build({ store: broken }).discard(found[0] as RecoveryInfo);
    expect(notices.join()).toContain("locked");
  });

  it("reports a failure to clear during discardAll", async () => {
    await withHistory();
    const broken: FileStore = {
      ...store,
      listRecoveries: () => store.listRecoveries(),
      clearRecovery: async () => {
        throw new FileStoreError("io", "busy");
      },
    };
    await build({ store: broken }).discardAll();
    expect(notices.join()).toContain("busy");
  });
});

describe("the crash-and-recover round trip", () => {
  it("gets the work back after a simulated crash", async () => {
    // The whole feature, end to end: edit, autosave, "crash" (a fresh session over
    // the same store), recover.
    edit("unsaved work");
    await actions.tick();

    // A new session: fresh actions and fresh app state, same backing store.
    state = { doc: docWith(""), handle: null, dirty: false, revision: 0, busy: false };
    const relaunched = build();

    const found = await relaunched.listRecoveries();
    expect(found).toHaveLength(1);
    await relaunched.restore(found[0] as RecoveryInfo);
    expect(toText(state.doc)).toContain("unsaved work");
  });

  it("offers nothing after a clean save and relaunch", async () => {
    edit("work");
    await actions.tick();
    await actions.save();

    state = { doc: docWith(""), handle: null, dirty: false, revision: 0, busy: false };
    expect(await build().listRecoveries()).toEqual([]);
  });
});
