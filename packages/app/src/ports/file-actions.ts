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
  ) => void;
  readonly markSaved: (handle: DocHandle) => void;
  readonly now: () => number;
  /** User-facing message. Warnings from `deserialize` arrive here too. */
  readonly notify: (message: string) => void;
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
  /** The key this session autosaves under, for tests and diagnostics. */
  autosaveKey(): string;
}

/**
 * A stable key for a document that has never been saved.
 *
 * Stable *per session*, so a session's snapshots accumulate into one history
 * rather than scattering one-per-tick under different keys. Minted lazily so a
 * session that only ever opens saved files never creates one.
 */
const untitledKey = (at: number): string => `untitled-${at}`;

export function createFileActions(deps: FileActionsDeps): FileActions {
  let autosave: AutosaveState = initialAutosaveState();
  let untitled: string | null = null;

  /** The key the current document autosaves under. */
  const keyFor = (handle: DocHandle | null): string => {
    if (handle !== null) return handle.key;
    untitled ??= untitledKey(deps.now());
    return untitled;
  };

  /** Steps shared by save and saveAs once a handle is known. */
  const afterWrite = async (handle: DocHandle, revision: number): Promise<void> => {
    deps.markSaved(handle);
    autosave = autosaveStateAfterSave(revision, deps.now());
    await deps.store.pushRecent(handle);
    // Clearing recovery last, and only after the write succeeded: a failure above
    // must leave the snapshots in place, since they are then the only copy.
    await deps.store.clearRecovery(handle.key);
    // A document saved under a real name no longer needs its untitled history.
    if (untitled !== null) {
      await deps.store.clearRecovery(untitled);
      untitled = null;
    }
  };

  const actions: FileActions = {
    async save() {
      const { doc, handle, revision } = deps.snapshot();
      if (handle === null) return actions.saveAs();
      try {
        await deps.store.save(handle, serialize(doc));
        await afterWrite(handle, revision);
        return true;
      } catch (error) {
        if (isCancelled(error)) return false;
        deps.notify(`Could not save: ${(error as Error).message}`);
        return false;
      }
    },

    async saveAs() {
      const { doc, handle, revision } = deps.snapshot();
      try {
        const suggested = handle?.label ?? "untitled.tui";
        const result = await deps.store.saveAs(serialize(doc), suggested);
        await afterWrite(result.handle, revision);
        return true;
      } catch (error) {
        if (isCancelled(error)) return false;
        deps.notify(`Could not save: ${(error as Error).message}`);
        return false;
      }
    },

    async open() {
      try {
        const opened = await deps.store.openWithPicker();
        return applyOpened(opened.content, opened.handle);
      } catch (error) {
        if (isCancelled(error)) return false;
        deps.notify(`Could not open: ${(error as Error).message}`);
        return false;
      }
    },

    async openHandle(handle) {
      try {
        const opened = await deps.store.openHandle(handle);
        return applyOpened(opened.content, opened.handle);
      } catch (error) {
        if (isCancelled(error)) return false;
        deps.notify(`Could not open ${handle.label}: ${(error as Error).message}`);
        return false;
      }
    },

    async tick() {
      const { doc, handle, dirty, revision, busy } = deps.snapshot();
      const decision = decideAutosave(autosave, { revision, at: deps.now(), busy, dirty });
      if (decision.t !== "write") return;

      try {
        await deps.store.writeRecovery(keyFor(handle), serialize(doc));
        // Advance only on success, so a failed write is retried next tick rather
        // than silently skipped for good.
        autosave = decision.state;
      } catch (error) {
        deps.notify(`Autosave failed: ${(error as Error).message}`);
      }
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
      deps.load(parsed, null, { dirty: true });
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
      return keyFor(deps.snapshot().handle);
    },
  };

  /** Shared tail of open and openHandle. */
  function applyOpened(content: string, handle: DocHandle): boolean {
    const result = readDocument(content);
    if (result === null) {
      deps.notify(`${handle.label} is not a readable .tui document.`);
      return false;
    }
    for (const warning of result.warnings) deps.notify(`${handle.label}: ${warning}`);
    deps.load(result.doc, handle);
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
