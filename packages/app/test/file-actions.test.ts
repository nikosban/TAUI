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
  generation: number;
  modifiedAt: number | null;
  busy: boolean;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function build(
  opts: {
    picker?: PickerFn;
    store?: FileStore;
    confirmConflict?: (message: string) => boolean;
  } = {},
): FileActions {
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
        generation: state.generation + 1,
        modifiedAt: opts?.modifiedAt ?? null,
      };
      return true;
    },
    markSaved: (handle, revision, generation, modifiedAt) => {
      if (state.generation !== generation) return false;
      state = { ...state, handle, modifiedAt, dirty: state.revision !== revision };
      return true;
    },
    confirmConflict: opts.confirmConflict ?? (() => true),
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
  state = {
    doc: docWith("start"),
    handle: null,
    dirty: false,
    revision: 0,
    generation: 0,
    modifiedAt: null,
    busy: false,
  };
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

  it("keeps edits and their recovery dirty when they happen during a save", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    state = { ...state, handle };
    edit("revision one");
    await actions.tick();

    const started = deferred<void>();
    const release = deferred<void>();
    const delayed: FileStore = {
      ...store,
      async save(target, content) {
        started.resolve();
        await release.promise;
        return store.save(target, content);
      },
    };
    const racing = build({ store: delayed });
    const saving = racing.save();
    await started.promise;

    edit("revision two");
    // This tick is ordered behind the save, so cleanup cannot delete the newer
    // recovery write even if both operations overlap at the UI level.
    const recovering = racing.tick();
    release.resolve();

    expect(await saving).toBe(true);
    await recovering;
    expect(storedText("a.tui")).toContain("revision one");
    expect(state.dirty).toBe(true);
    // The pre-save snapshot was not discarded even though the disk write
    // succeeded. The tick queued during save is interval-guarded relative to
    // that save, so the next due tick records the newer edit.
    expect(store.recoverySnapshot()["a.tui"]).toHaveLength(1);
    expect(snapshotText({ content: store.recoverySnapshot()["a.tui"]?.at(-1) ?? "" })).toContain(
      "revision one",
    );

    clock += AUTOSAVE_INTERVAL_MS;
    await racing.tick();
    expect(store.recoverySnapshot()["a.tui"]).toHaveLength(2);
    expect(snapshotText({ content: store.recoverySnapshot()["a.tui"]?.at(-1) ?? "" })).toContain(
      "revision two",
    );
  });

  it("adopts a Save As handle without marking edits made in flight clean", async () => {
    edit("revision one");
    const started = deferred<void>();
    const release = deferred<void>();
    const delayed: FileStore = {
      ...store,
      async saveAs(content, suggestedName) {
        started.resolve();
        await release.promise;
        return store.saveAs(content, suggestedName);
      },
    };
    const racing = build({ store: delayed });
    const saving = racing.saveAs();
    await started.promise;

    edit("revision two");
    release.resolve();

    expect(await saving).toBe(true);
    expect(state.handle?.key).toBe("a.tui");
    expect(state.dirty).toBe(true);
    expect(storedText("a.tui")).toContain("revision one");
  });

  it("does not let a stale Save As completion overwrite a replacement document", async () => {
    edit("original document");
    const started = deferred<void>();
    const release = deferred<void>();
    const delayed: FileStore = {
      ...store,
      async saveAs(content, suggestedName) {
        started.resolve();
        await release.promise;
        return store.saveAs(content, suggestedName);
      },
    };
    const racing = build({ store: delayed });
    const saving = racing.saveAs();
    await started.promise;

    const replacement = docWith("replacement document");
    const replacementHandle = { key: "replacement.tui", label: "replacement.tui", display: "r" };
    state = {
      ...state,
      doc: replacement,
      handle: replacementHandle,
      dirty: false,
      revision: state.revision + 1,
      generation: state.generation + 1,
    };
    release.resolve();

    expect(await saving).toBe(true);
    expect(storedText("a.tui")).toContain("original document");
    expect(state.doc).toBe(replacement);
    expect(state.handle).toEqual(replacementHandle);
    expect(state.dirty).toBe(false);
  });

  it("serializes overlapping saves and coalesces queued requests", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    state = { ...state, handle };
    edit("revision one");

    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const writes: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const delayed: FileStore = {
      ...store,
      async save(target, content) {
        const index = writes.push(content) - 1;
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        if (index === 0) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
        const result = await store.save(target, content);
        activeWrites--;
        return result;
      },
    };
    const racing = build({ store: delayed });
    const first = racing.save();
    await firstStarted.promise;

    edit("revision two");
    const second = racing.save();
    const third = racing.save();
    expect(writes).toHaveLength(1);

    releaseFirst.resolve();
    await secondStarted.promise;
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(writes).toHaveLength(2);
    expect(maxActiveWrites).toBe(1);
    expect(storedText("a.tui")).toContain("revision two");
    expect(state.dirty).toBe(false);
  });

  it("does not apply a queued save request to a replacement document", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    state = { ...state, handle };
    edit("original document");

    const started = deferred<void>();
    const release = deferred<void>();
    let writes = 0;
    const delayed: FileStore = {
      ...store,
      async save(target, content) {
        writes++;
        started.resolve();
        await release.promise;
        return store.save(target, content);
      },
    };
    const racing = build({ store: delayed });
    const first = racing.save();
    await started.promise;
    const queued = racing.save();

    state = {
      ...state,
      doc: docWith("replacement"),
      handle: null,
      dirty: false,
      revision: state.revision + 1,
      generation: state.generation + 1,
    };
    release.resolve();

    expect(await first).toBe(true);
    expect(await queued).toBe(false);
    expect(writes).toBe(1);
    expect(state.handle).toBeNull();
  });

  it.each([
    ["recent files", "pushRecent"],
    ["recovery data", "clearRecovery"],
  ] as const)(
    "does not turn a successful write into failure when %s cleanup fails",
    async (_, op) => {
      const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
      state = { ...state, handle };
      edit("safely written");
      const broken: FileStore = {
        ...store,
        [op]: async () => {
          throw new FileStoreError("io", "bookkeeping unavailable");
        },
      };

      expect(await build({ store: broken }).save()).toBe(true);
      expect(storedText("a.tui")).toContain("safely written");
      expect(state.dirty).toBe(false);
      expect(notices.join()).toContain("Saved, but");
    },
  );

  it("keeps a newer external version when conflict replacement is declined", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    const opened = await store.save(handle, serialize(docWith("opened")));
    state = { ...state, handle, modifiedAt: opened.modifiedAt };
    edit("local edit");
    await store.save(handle, serialize(docWith("external edit")), { force: true });
    const prompts: string[] = [];

    const conflicting = build({
      confirmConflict: (message) => {
        prompts.push(message);
        return false;
      },
    });
    expect(await conflicting.save()).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(storedText("a.tui")).toContain("external edit");
    expect(state.dirty).toBe(true);
  });

  it("replaces a conflicting external version only after confirmation", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    const opened = await store.save(handle, serialize(docWith("opened")));
    state = { ...state, handle, modifiedAt: opened.modifiedAt };
    edit("confirmed local edit");
    await store.save(handle, serialize(docWith("external edit")), { force: true });

    expect(await build({ confirmConflict: () => true }).save()).toBe(true);
    expect(storedText("a.tui")).toContain("confirmed local edit");
    expect(state.dirty).toBe(false);
    expect(state.modifiedAt).not.toBe(opened.modifiedAt);
  });
});

describe("open", () => {
  it("keeps one open operation and one picker owner at a time", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let reads = 0;
    const delayed: FileStore = {
      ...store,
      async openWithPicker() {
        reads++;
        started.resolve();
        await release.promise;
        return {
          content: serialize(docWith("opened once")),
          handle: { key: "opened.tui", label: "opened.tui", display: "opened.tui" },
          modifiedAt: clock,
        };
      },
    };
    const racing = build({ store: delayed });
    const transitions: string[] = [];
    const unsubscribe = racing.subscribe((status) => transitions.push(status.kind));

    const first = racing.open();
    await started.promise;
    expect(racing.status()).toEqual({ kind: "open", busy: true });

    // Neither call may create a second picker or save beside the open.
    expect(await racing.open()).toBe(false);
    expect(await racing.save()).toBe(false);
    expect(reads).toBe(1);

    release.resolve();
    expect(await first).toBe(true);
    expect(toText(state.doc)).toContain("opened once");
    expect(racing.status()).toEqual({ kind: "idle", busy: false });
    expect(transitions).toEqual(["open", "idle"]);
    unsubscribe();
  });

  it("rejects an open while a save owns the persistence lane", async () => {
    const handle = { key: "a.tui", label: "a.tui", display: "a.tui" };
    state = { ...state, handle, dirty: true };
    const started = deferred<void>();
    const release = deferred<void>();
    let opens = 0;
    const delayed: FileStore = {
      ...store,
      async save(target, content) {
        started.resolve();
        await release.promise;
        return store.save(target, content);
      },
      async openWithPicker() {
        opens++;
        return store.openWithPicker();
      },
    };
    const racing = build({ store: delayed });
    const saving = racing.save();
    await started.promise;

    expect(racing.status().kind).toBe("save");
    expect(await racing.open()).toBe(false);
    expect(opens).toBe(0);

    release.resolve();
    expect(await saving).toBe(true);
    expect(racing.status().kind).toBe("idle");
  });

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

  it("propagates a declined document replacement without changing the current one", async () => {
    const before = state.doc;
    const opening = createFileActions({
      store: createMemoryFileStore({
        picker: async () => "other.tui",
        now: () => clock,
        initial: { "other.tui": serialize(docWith("other")) },
      }),
      snapshot: () => state,
      load: () => false,
      markSaved: () => true,
      confirmConflict: () => true,
      now: () => clock,
      notify: (message) => notices.push(message),
    });

    expect(await opening.open()).toBe(false);
    expect(state.doc).toBe(before);
    expect(notices).toEqual([]);
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
  it("coalesces repeated ticks behind one slow recovery write", async () => {
    edit("slow snapshot");
    const started = deferred<void>();
    const release = deferred<void>();
    let writes = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const delayed: FileStore = {
      ...store,
      async writeRecovery(key, content) {
        writes++;
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        started.resolve();
        await release.promise;
        await store.writeRecovery(key, content);
        activeWrites--;
      },
    };
    const racing = build({ store: delayed });

    const first = racing.tick();
    await started.promise;
    const second = racing.tick();
    const third = racing.tick();
    expect(writes).toBe(1);

    release.resolve();
    await Promise.all([first, second, third]);
    expect(writes).toBe(1);
    expect(maxActiveWrites).toBe(1);
    expect(await racing.listRecoveries()).toHaveLength(1);
  });

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

  it("keeps untitled recovery histories separate across document generations", async () => {
    edit("first document");
    await actions.tick();
    const firstKey = actions.autosaveKey();

    state = {
      ...state,
      doc: docWith("second document"),
      handle: null,
      dirty: false,
      revision: state.revision + 1,
      generation: state.generation + 1,
    };
    edit("second document edited");
    await actions.tick();
    const secondKey = actions.autosaveKey();

    expect(secondKey).not.toBe(firstKey);
    expect(Object.keys(store.recoverySnapshot()).sort()).toEqual([firstKey, secondKey].sort());

    await actions.save();
    expect(Object.keys(store.recoverySnapshot())).toEqual([firstKey]);
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

  it("keeps a recovery available when its document replacement is declined", async () => {
    await withHistory();
    const [newest] = await actions.listRecoveries();
    const before = state.doc;
    const declining = createFileActions({
      store,
      snapshot: () => state,
      load: () => false,
      markSaved: () => true,
      confirmConflict: () => true,
      now: () => clock,
      notify: (message) => notices.push(message),
    });

    expect(await declining.restore(newest as RecoveryInfo)).toBe(false);
    expect(state.doc).toBe(before);
    expect(notices).not.toContain(expect.stringContaining("Restored"));
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
    state = {
      doc: docWith(""),
      handle: null,
      dirty: false,
      revision: 0,
      generation: 0,
      modifiedAt: null,
      busy: false,
    };
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

    state = {
      doc: docWith(""),
      handle: null,
      dirty: false,
      revision: 0,
      generation: 0,
      modifiedAt: null,
      busy: false,
    };
    expect(await build().listRecoveries()).toEqual([]);
  });
});
