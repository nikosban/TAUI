/**
 * When to write an autosave snapshot.
 *
 * A pure decision function with time passed in, so its tests need no fake timers —
 * the same shape as the typing-burst reducer.
 *
 * **Guarded on a revision counter, not on `dirty`.** A dirty flag stays true from
 * the first edit until the next save, so a dirty-guarded autosave rewrites an
 * identical blob every interval while the user reads the screen. With a rolling
 * history that is worse than wasteful: it floods the history with duplicates and
 * pushes out the genuinely distinct states the history exists to keep.
 */

/** Everything the decision depends on. Plain data, so a test can state a case. */
export interface AutosaveInput {
  /** Monotonic edit counter from the document store. */
  readonly revision: number;
  /** Now, in epoch ms. */
  readonly at: number;
  /** True while a gesture or typing burst is mid-flight. */
  readonly busy: boolean;
  /** False when the document has no unsaved changes at all. */
  readonly dirty: boolean;
}

export interface AutosaveState {
  /** Revision at the last snapshot, or null if none has been written. */
  readonly lastRevision: number | null;
  /** When the last snapshot was written. */
  readonly lastAt: number;
}

export const AUTOSAVE_INTERVAL_MS = 30_000;

export interface AutosaveConfig {
  readonly intervalMs?: number;
}

export const initialAutosaveState = (): AutosaveState => ({ lastRevision: null, lastAt: 0 });

export type AutosaveDecision =
  | { readonly t: "write"; readonly state: AutosaveState }
  | { readonly t: "skip"; readonly reason: AutosaveSkipReason };

type AutosaveSkipReason =
  /** Nothing to lose. */
  | "clean"
  /** No edit since the last snapshot — the revision guard doing its job. */
  | "unchanged"
  /** Too soon. */
  | "interval"
  /**
   * A gesture is open, so the document is mid-edit.
   *
   * Snapshotting now would capture a half-drawn box as a recovery point. Waiting
   * costs at most one interval, and the next tick catches it.
   */
  | "busy";

/**
 * Decides whether to snapshot, and returns the state to carry forward on a write.
 *
 * The order of the guards matters: `clean` before `unchanged` so a saved document
 * reports the more useful reason, and `busy` last so it is only reported when a
 * write would otherwise have happened.
 */
export function decideAutosave(
  state: AutosaveState,
  input: AutosaveInput,
  config: AutosaveConfig = {},
): AutosaveDecision {
  if (!input.dirty) return { t: "skip", reason: "clean" };
  if (state.lastRevision === input.revision) return { t: "skip", reason: "unchanged" };

  const interval = config.intervalMs ?? AUTOSAVE_INTERVAL_MS;
  // A first snapshot still waits out one interval: a document opened and
  // immediately edited should not write before the user has paused once.
  if (input.at - state.lastAt < interval) return { t: "skip", reason: "interval" };

  if (input.busy) return { t: "skip", reason: "busy" };

  return { t: "write", state: { lastRevision: input.revision, lastAt: input.at } };
}

/**
 * State to adopt after an explicit save.
 *
 * Recording the revision stops the next tick from writing a snapshot identical to
 * what was just saved to disk. `lastAt` moves too, so the interval restarts from
 * the save rather than from the last autosave.
 */
export const autosaveStateAfterSave = (revision: number, at: number): AutosaveState => ({
  lastRevision: revision,
  lastAt: at,
});
