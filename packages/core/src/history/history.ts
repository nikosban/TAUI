/**
 * Undo/redo as a stack of whole-document snapshots.
 *
 * Documents are small (a fully painted 120x40 grid is a few hundred KB, and real
 * mockups are far sparser), and structural sharing means consecutive snapshots
 * share every layer the edit did not touch. So snapshotting is cheap and removes
 * the entire class of bugs that come with inverse operations — there is no "undo
 * of a merge-down" to get wrong.
 *
 * **What the engine does not decide:** where the boundaries are. One *gesture*
 * should be one entry, and only the GUI knows when a drag ended or a typing burst
 * went idle. The engine's contribution is that `push` is a no-op when nothing
 * changed, which combined with the ops' referential-equality guarantee means an
 * empty gesture cannot pollute the stack even if the GUI pushes optimistically.
 */

import type { TuiDocument } from "../model/document.js";

/** Maximum number of undo steps retained. Oldest entries are dropped first. */
export const MAX_HISTORY = 200;

export interface History {
  /** Oldest first. The most recent undoable state is the last element. */
  readonly past: readonly TuiDocument[];
  readonly present: TuiDocument;
  /** Next redoable state first. */
  readonly future: readonly TuiDocument[];
}

export function createHistory(present: TuiDocument): History {
  return { past: [], present, future: [] };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

/**
 * Commits a new present, discarding any redo branch.
 *
 * Returns the same history object when `doc` is referentially equal to the
 * current present — the ops layer guarantees that identity for no-ops, so a
 * gesture that changed nothing adds no entry.
 */
export function push(h: History, doc: TuiDocument): History {
  if (doc === h.present) return h;
  const past = [...h.past, h.present];
  // Drop from the front once the cap is exceeded, so the *recent* history is
  // what survives.
  const trimmed = past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past;
  return { past: trimmed, present: doc, future: [] };
}

export function undo(h: History): History {
  const previous = h.past[h.past.length - 1];
  if (previous === undefined) return h;
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redo(h: History): History {
  const next = h.future[0];
  if (next === undefined) return h;
  return {
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
  };
}

/**
 * Replaces the present without creating an undo entry.
 *
 * For in-progress gesture previews: the GUI renders a scratch document derived
 * from `present`, and only calls {@link push} on pointer-up. Provided so that
 * path never has to reach into the history object directly.
 */
export function replacePresent(h: History, doc: TuiDocument): History {
  if (doc === h.present) return h;
  return { ...h, present: doc };
}

/** Discards all undo/redo state, keeping the current document. Used on file open. */
export function resetHistory(h: History): History {
  if (h.past.length === 0 && h.future.length === 0) return h;
  return { past: [], present: h.present, future: [] };
}
