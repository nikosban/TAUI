/**
 * Save, open, and autosave, with every dependency injected.
 *
 * All the sequencing that can be wrong lives here rather than in a React
 * component: what order a save does its steps in, when a recovery blob is safe to
 * discard, which key an unsaved document autosaves under. Those are testable
 * facts, and a component would make them reachable only through a rendered tree.
 *
 * `serialize`/`deserialize` are called here, not in an adapter — the port speaks
 * strings so adapters never import core.
 */

import { deserialize, serialize, type TuiDocument } from "@tui-designer/core";
import {
  type AutosaveState,
  autosaveStateAfterSave,
  decideAutosave,
  initialAutosaveState,
} from "./autosave.js";
import type { DocHandle, FileStore, RecoveryInfo } from "./file-store.js";
import { isCancelled } from "./file-store.js";

export interface FileActionsDeps {
  readonly store: FileStore;
  /** Current document plus the state autosave needs to decide. */
  readonly snapshot: () => {
    readonly doc: TuiDocument;
    readonly handle: DocHandle | null;
    readonly dirty: boolean;
    readonly revision: number;
    /** Changes only when a different document is loaded or created. */
    readonly generation: number;
    /**
     * True while a gesture or typing burst is open.
     *
     * Must include *typing*, not just pointer gestures: `preview()` bumps the
     * revision per keystroke, so a typing-only burst would otherwise look like a
     * settled new state and get snapshotted half-typed.
     */
    readonly busy: boolean;
  };
  /**
   * Adopts a document. `dirty` marks it as differing from any file, which a
   * restored recovery snapshot always does.
   */
  readonly load: (
    doc: TuiDocument,
    handle: DocHandle | null,
    opts?: { readonly dirty?: boolean },
  ) => boolean;
  /** Acknowledges the exact revision a completed write persisted. */
  readonly markSaved: (handle: DocHandle, revision: number, generation: number) => boolean;
  readonly now: () => number;
  /** User-facing message. Warnings from `deserialize` arrive here too. */
  readonly notify: (message: string) => void;
}

type FileOperationKind = "idle" | "save" | "open";

interface FileOperationStatus {
  readonly kind: FileOperationKind;
  readonly busy: boolean;
}

export interface FileActions {
  /** Saves to the current handle, falling back to Save As when there is none. */
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  open(): Promise<boolean>;
  openHandle(handle: DocHandle): Promise<boolean>;
  /** One autosave tick. Cheap when nothing is due. */
  tick(): Promise<void>;
  /** Snapshots worth offering, newest first. */
  listRecoveries(): Promise<RecoveryInfo[]>;
  /** Loads a snapshot as the current document, leaving it dirty and unsaved. */
  restore(info: RecoveryInfo): Promise<boolean>;
  discard(info: RecoveryInfo): Promise<void>;
  discardAll(): Promise<void>;
  /** The key the current document generation autosaves under. */
  autosaveKey(): string;
  /** Current interactive operation; autosave is deliberately background-only. */
  status(): FileOperationStatus;
  /** Observes operation transitions so React can disable conflicting commands. */
  subscribe(listener: (status: FileOperationStatus) => void): () => void;
}

/**
 * A stable key for a document that has never been saved.
 *
 * Stable *per document generation*, so one document's snapshots accumulate into
 * one history without mixing two unsaved documents opened in the same session.
 * Minted lazily so a document that is saved before its first autosave never
 * creates one.
 */
const untitledKey = (at: number, generation: number): string => `untitled-${at}-${generation}`;

export function createFileActions(deps: FileActionsDeps): FileActions {
  let autosave: AutosaveState = initialAutosaveState();
  let untitled: { readonly key: string; readonly generation: number } | null = null;

  /**
   * Save requests are drained in order, with requests arriving during a write
   * coalesced into one follow-up write. Autosave shares the persistence lane so
   * it cannot race recovery cleanup.
   */
  type SaveKind = "save" | "saveAs";
  interface SaveBatch {
    kind: SaveKind;
    readonly generation: number;
    readonly settle: Array<(saved: boolean) => void>;
  }
  const saveQueue: SaveBatch[] = [];
  let drainingSaves = false;
  let persistenceTail: Promise<void> = Promise.resolve();
  let operation: FileOperationKind = "idle";
  const operationListeners = new Set<(status: FileOperationStatus) => void>();

  const operationStatus = (): FileOperationStatus => ({
    kind: operation,
    busy: operation !== "idle",
  });

  const setOperation = (next: FileOperationKind): void => {
    if (operation === next) return;
    operation = next;
    const status = operationStatus();
    for (const listener of operationListeners) listener(status);
  };

  const inPersistenceOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const result = persistenceTail.then(work, work);
    persistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** The key the current document autosaves under. */
  const keyFor = (handle: DocHandle | null, generation: number): string => {
    if (handle !== null) return handle.key;
    if (untitled?.generation !== generation) {
      untitled = { key: untitledKey(deps.now(), generation), generation };
    }
    return untitled.key;
  };

  /** Best-effort bookkeeping after the document bytes are safely on disk. */
  const afterWrite = async (
    handle: DocHandle,
    revision: number,
    generation: number,
    untitledRecoveryKey: string | null,
  ): Promise<void> => {
    const belongsToCurrentDocument = deps.markSaved(handle, revision, generation);
    if (belongsToCurrentDocument) autosave = autosaveStateAfterSave(revision, deps.now());

    const writtenRevisionIsCurrent = (): boolean => {
      const current = deps.snapshot();
      return (
        current.generation === generation &&
        current.revision === revision &&
        !current.dirty &&
        current.handle?.key === handle.key
      );
    };

    try {
      await deps.store.pushRecent(handle);
    } catch (error) {
      deps.notify(`Saved, but could not update recent files: ${(error as Error).message}`);
    }

    // The bytes still landed and belong in recents, but no state or recovery
    // belonging to a replacement document may be touched by this completion.
    if (!belongsToCurrentDocument) return;

    // Never discard recovery for work newer than the bytes just written. Check
    // after the asynchronous recents update because editing may continue while
    // any part of a save is in flight.
    if (!writtenRevisionIsCurrent()) return;

    try {
      await deps.store.clearRecovery(handle.key);
    } catch (error) {
      deps.notify(`Saved, but could not clear recovery data: ${(error as Error).message}`);
    }

    // A document saved under a real name no longer needs its untitled history.
    // Retain the key on failure so a later clean save can try the cleanup again.
    if (untitledRecoveryKey !== null && writtenRevisionIsCurrent()) {
      try {
        await deps.store.clearRecovery(untitledRecoveryKey);
        if (untitled?.key === untitledRecoveryKey) untitled = null;
      } catch (error) {
        deps.notify(`Saved, but could not clear recovery data: ${(error as Error).message}`);
      }
    }
  };

  const performSave = async (kind: SaveKind, requestedGeneration: number): Promise<boolean> => {
    const { doc, handle, revision, generation } = deps.snapshot();
    // A queued click belongs to the document that was visible when it happened.
    // If that document was replaced while an earlier write was in flight, do not
    // unexpectedly save the replacement (or open a Save As dialog for it).
    if (generation !== requestedGeneration) return false;
    const untitledRecoveryKey =
      untitled?.generation === generation && handle === null ? untitled.key : null;
    try {
      if (kind === "saveAs" || handle === null) {
        const suggested = handle?.label ?? "untitled.tui";
        const result = await deps.store.saveAs(serialize(doc), suggested);
        await afterWrite(result.handle, revision, generation, untitledRecoveryKey);
      } else {
        await deps.store.save(handle, serialize(doc));
        await afterWrite(handle, revision, generation, untitledRecoveryKey);
      }
      return true;
    } catch (error) {
      if (isCancelled(error)) return false;
      deps.notify(`Could not save: ${(error as Error).message}`);
      return false;
    }
  };

  const drainSaves = async (): Promise<void> => {
    if (drainingSaves) return;
    drainingSaves = true;
    setOperation("save");
    try {
      while (saveQueue.length > 0) {
        const batch = saveQueue.shift() as SaveBatch;
        const saved = await inPersistenceOrder(() => performSave(batch.kind, batch.generation));
        for (const settle of batch.settle) settle(saved);
      }
    } finally {
      drainingSaves = false;
      setOperation("idle");
      // A request can be queued by a completion handler after the loop observes
      // null but before this task yields back to the browser.
      if (saveQueue.length > 0) void drainSaves();
    }
  };

  const requestSave = (kind: SaveKind): Promise<boolean> =>
    new Promise((resolve) => {
      // An open may own a picker and the document-replacement boundary. Starting
      // a save beside it could open a second picker or persist the wrong document.
      if (operation === "open") {
        resolve(false);
        return;
      }
      const generation = deps.snapshot().generation;
      const queued = saveQueue.at(-1);
      if (queued === undefined || queued.generation !== generation) {
        saveQueue.push({ kind, generation, settle: [resolve] });
      } else {
        // An explicit Save As is never weakened by a concurrent ordinary Save.
        if (kind === "saveAs") queued.kind = "saveAs";
        queued.settle.push(resolve);
      }
      void drainSaves();
    });

  const requestOpen = async (
    read: () => Promise<{ readonly content: string; readonly handle: DocHandle }>,
    failureLabel: string,
  ): Promise<boolean> => {
    // Re-entrant opens and opens during a save are deliberately rejected. The
    // current picker remains the sole owner of its promise and interaction state.
    if (operation !== "idle") return false;
    setOperation("open");
    try {
      return await inPersistenceOrder(async () => {
        const opened = await read();
        return applyOpened(opened.content, opened.handle);
      });
    } catch (error) {
      if (isCancelled(error)) return false;
      deps.notify(`${failureLabel}: ${(error as Error).message}`);
      return false;
    } finally {
      setOperation("idle");
    }
  };

  let autosaveFlight: Promise<void> | null = null;
  let autosaveTickQueued = false;

  const performAutosaveTick = (): Promise<void> =>
    inPersistenceOrder(async () => {
      const { doc, handle, dirty, revision, generation, busy } = deps.snapshot();
      const decision = decideAutosave(autosave, { revision, at: deps.now(), busy, dirty });
      if (decision.t !== "write") return;

      try {
        await deps.store.writeRecovery(keyFor(handle, generation), serialize(doc));
        // Advance only on success, so a failed write is retried next tick rather
        // than silently skipped for good.
        autosave = decision.state;
      } catch (error) {
        deps.notify(`Autosave failed: ${(error as Error).message}`);
      }
    });

  const requestAutosaveTick = (): Promise<void> => {
    if (autosaveFlight !== null) {
      // At most one trailing evaluation is useful: it observes any edit that
      // landed while the active write was slow, without accumulating timer calls.
      autosaveTickQueued = true;
      return autosaveFlight;
    }

    autosaveFlight = (async () => {
      do {
        autosaveTickQueued = false;
        await performAutosaveTick();
      } while (autosaveTickQueued);
    })().finally(() => {
      autosaveFlight = null;
    });
    return autosaveFlight;
  };

  const actions: FileActions = {
    async save() {
      return requestSave("save");
    },

    async saveAs() {
      return requestSave("saveAs");
    },

    async open() {
      return requestOpen(() => deps.store.openWithPicker(), "Could not open");
    },

    async openHandle(handle) {
      return requestOpen(() => deps.store.openHandle(handle), `Could not open ${handle.label}`);
    },

    async tick() {
      await requestAutosaveTick();
    },

    async listRecoveries() {
      try {
        return await deps.store.listRecoveries();
      } catch (error) {
        // A broken recovery directory must not stop the app starting.
        deps.notify(`Could not read recovery data: ${(error as Error).message}`);
        return [];
      }
    },

    async restore(info) {
      const parsed = parse(info.content);
      if (parsed === null) {
        deps.notify(`That recovery snapshot is unreadable.`);
        return false;
      }
      // Deliberately restored with **no handle and dirty**. No handle, because the
      // snapshot is newer than the file and a later save must not silently clobber
      // whatever the last real save contained. Dirty, because it exists nowhere on
      // disk — reporting it as saved would suppress the unload warning and let the
      // user lose the recovered work a second time.
      if (!deps.load(parsed, null, { dirty: true })) return false;
      deps.notify(`Restored an unsaved snapshot of ${info.handle.label}. Save to keep it.`);
      return true;
    },

    async discard(info) {
      try {
        await deps.store.dropRecovery(info.id);
      } catch (error) {
        deps.notify(`Could not discard that snapshot: ${(error as Error).message}`);
      }
    },

    async discardAll() {
      const found = await actions.listRecoveries();
      // Group first: clearRecovery works per document, so one call per key beats
      // one per snapshot.
      for (const key of new Set(found.map((info) => info.handle.key))) {
        try {
          await deps.store.clearRecovery(key);
        } catch (error) {
          deps.notify(`Could not discard snapshots for ${key}: ${(error as Error).message}`);
        }
      }
    },

    autosaveKey() {
      const { handle, generation } = deps.snapshot();
      return keyFor(handle, generation);
    },

    status() {
      return operationStatus();
    },

    subscribe(listener) {
      operationListeners.add(listener);
      return () => operationListeners.delete(listener);
    },
  };

  /** Shared tail of open and openHandle. */
  function applyOpened(content: string, handle: DocHandle): boolean {
    const result = readDocument(content);
    if (result === null) {
      deps.notify(`${handle.label} is not a readable .tui document.`);
      return false;
    }
    if (!deps.load(result.doc, handle)) return false;
    for (const warning of result.warnings) deps.notify(`${handle.label}: ${warning}`);
    autosave = autosaveStateAfterSave(deps.snapshot().revision, deps.now());
    return true;
  }

  return actions;
}

/** `deserialize`, returning null instead of throwing on malformed input. */
function readDocument(content: string): { doc: TuiDocument; warnings: readonly string[] } | null {
  try {
    return deserialize(content);
  } catch {
    return null;
  }
}

const parse = (content: string): TuiDocument | null => readDocument(content)?.doc ?? null;
