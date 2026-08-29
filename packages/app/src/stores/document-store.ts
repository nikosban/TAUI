/**
 * The only owner of engine state.
 *
 * `revision` increments on every change to the present document. The canvas
 * painter subscribes to it imperatively rather than through a React hook, so
 * pointer-driven repaints never enter React's scheduler — and an autosave driver
 * can guard on the revision rather than on `dirty` alone, avoiding a rewrite of
 * an identical blob every 30s while the user reads the screen.
 *
 * `commit` accepts only a {@link CommittedDoc} — a document branded by
 * `sealCommit`, which only the gesture machinery may call. That makes this the
 * single `push` call site in the whole application, enforced by the compiler
 * rather than by review.
 */

import {
  canRedo,
  canUndo,
  createHistory,
  type History,
  push,
  redo,
  replacePresent,
  type TuiDocument,
  undo,
} from "@tui-designer/core";
import { create } from "zustand";
import type { CommittedDoc } from "../gestures/commit.js";
import type { DocHandle } from "../ports/file-store.js";

export interface DocumentState {
  history: History;
  handle: DocHandle | null;
  dirty: boolean;
  /** Bumped whenever `history.present` changes, including during a drag preview. */
  revision: number;

  present(): TuiDocument;
  canUndo(): boolean;
  canRedo(): boolean;

  /**
   * Commits one undoable step.
   *
   * Takes a {@link CommittedDoc}, not a `TuiDocument`, so passing the raw result
   * of a draw op is a type error. This is the only path to `push`.
   */
  commit(doc: CommittedDoc): void;
  /** Replaces the present without an undo entry — for in-progress drag previews. */
  preview(doc: TuiDocument): void;
  undo(): void;
  redo(): void;
  /** Adopts a freshly opened or created document, discarding history. */
  load(doc: TuiDocument, handle: DocHandle | null): void;
  markSaved(handle: DocHandle): void;
  /**
   * Marks the document as differing from any file.
   *
   * Needed by recovery: a restored snapshot has no handle and exists nowhere on
   * disk, so reporting it as saved would suppress the unload warning and let the
   * user lose the recovered work a second time.
   */
  markDirty(): void;
}

export function createDocumentStore(initial: TuiDocument) {
  return create<DocumentState>((set, get) => ({
    history: createHistory(initial),
    handle: null,
    dirty: false,
    revision: 0,

    present() {
      return get().history.present;
    },
    canUndo() {
      return canUndo(get().history);
    },
    canRedo() {
      return canRedo(get().history);
    },

    commit(doc) {
      const history = push(get().history, doc);
      // core returns the identical history object when nothing changed, so an
      // empty gesture bumps neither the revision nor the dirty flag.
      if (history === get().history) return;
      set({ history, dirty: true, revision: get().revision + 1 });
    },

    preview(doc) {
      const history = replacePresent(get().history, doc);
      if (history === get().history) return;
      set({ history, revision: get().revision + 1 });
    },

    undo() {
      const history = undo(get().history);
      if (history === get().history) return;
      set({ history, dirty: true, revision: get().revision + 1 });
    },

    redo() {
      const history = redo(get().history);
      if (history === get().history) return;
      set({ history, dirty: true, revision: get().revision + 1 });
    },

    load(doc, handle) {
      set({
        history: createHistory(doc),
        handle,
        dirty: false,
        revision: get().revision + 1,
      });
    },

    markSaved(handle) {
      set({ handle, dirty: false });
    },

    markDirty() {
      if (get().dirty) return;
      set({ dirty: true, revision: get().revision + 1 });
    },
  }));
}
