/**
 * Typing-burst coalescing. Pure, with time passed in.
 *
 * A typing burst is one undoable step: type "STATUS" and a single undo removes
 * all six characters, not one. The spec calls for a flush on tool change, Enter,
 * or 1s idle; two more flush reasons matter just as much and are easy to miss:
 *
 * - **`undo-requested`** — Cmd+Z during an open burst must flush *first*, then
 *   undo. Without it, the uncommitted keystrokes are silently discarded and the
 *   undo removes the *previous* entry instead. This is the single most likely
 *   coalescing bug to ship.
 * - **`save`** — saving mid-burst must flush, or the written file is missing the
 *   last few characters typed.
 *
 * Time is a parameter rather than read from a clock, so every test below runs
 * without fake timers.
 */

import type { TuiDocument } from "@tui-designer/core";
import type { CellPos } from "../canvas/metrics.js";
import { type CommittedDoc, sealCommit } from "./commit.js";

export const BURST_IDLE_MS = 1000;

export interface BurstState {
  /** The document as of the burst's start — what an undo returns to. */
  readonly baseAtStart: TuiDocument;
  /** Accumulated result. Rendered while the burst is open. */
  readonly working: TuiDocument;
  readonly lastKeyAt: number;
  /** Where typing began, for Enter's column-aligned newline. */
  readonly caretOrigin: CellPos;
  readonly keyCount: number;
}

export type FlushReason =
  | "idle"
  | "enter"
  | "caret-moved"
  | "tool-change"
  | "blur"
  | "undo-requested"
  | "save"
  | "document-replacement"
  | "layer-change"
  | "selection-change";

export type BurstInput =
  /** `doc` is the working document *after* applying the keystroke. */
  | {
      readonly t: "keystroke";
      readonly doc: TuiDocument;
      readonly caretOrigin: CellPos;
      readonly at: number;
    }
  /** Periodic poll, ~250ms, which detects the idle timeout. */
  | { readonly t: "tick"; readonly at: number }
  | { readonly t: "flush"; readonly reason: FlushReason };

type BurstOutput =
  | { readonly t: "open"; readonly working: TuiDocument }
  | { readonly t: "flush"; readonly commit: CommittedDoc; readonly reason: FlushReason }
  | { readonly t: "none" };

export interface BurstStep {
  readonly state: BurstState | null;
  readonly out: BurstOutput;
}

export interface BurstConfig {
  readonly idleMs?: number;
}

export function reduceBurst(
  state: BurstState | null,
  input: BurstInput,
  config: BurstConfig = {},
): BurstStep {
  const idleMs = config.idleMs ?? BURST_IDLE_MS;

  switch (input.t) {
    case "keystroke": {
      if (state === null) {
        // Opening a burst records the pre-typing document as the undo target.
        return {
          state: {
            baseAtStart: input.doc,
            working: input.doc,
            lastKeyAt: input.at,
            caretOrigin: input.caretOrigin,
            keyCount: 1,
          },
          out: { t: "open", working: input.doc },
        };
      }
      return {
        state: {
          ...state,
          working: input.doc,
          lastKeyAt: input.at,
          keyCount: state.keyCount + 1,
        },
        out: { t: "open", working: input.doc },
      };
    }

    case "tick": {
      if (state === null) return { state, out: { t: "none" } };
      if (input.at - state.lastKeyAt < idleMs) return { state, out: { t: "none" } };
      return {
        state: null,
        out: { t: "flush", commit: sealCommit(state.working), reason: "idle" },
      };
    }

    case "flush": {
      if (state === null) return { state, out: { t: "none" } };
      return {
        state: null,
        out: { t: "flush", commit: sealCommit(state.working), reason: input.reason },
      };
    }
  }
}

/**
 * The document to render: the open burst's working copy, or `fallback`.
 *
 * Keeps callers from reaching into `BurstState` and forgetting the null case.
 */
export function burstDoc(state: BurstState | null, fallback: TuiDocument): TuiDocument {
  return state?.working ?? fallback;
}

/** True when a burst is open, so callers can decide whether a flush is needed. */
export const burstOpen = (state: BurstState | null): boolean => state !== null;
