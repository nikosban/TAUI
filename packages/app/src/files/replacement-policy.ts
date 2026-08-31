/**
 * The one policy for adopting a different document.
 *
 * File pickers and recovery parsing happen before this boundary. That ordering is
 * deliberate: a cancelled picker or an unreadable file never disturbs the current
 * gesture, typing burst, selection, or document. Once a valid replacement reaches
 * this function, the dirty guard runs before any state is changed.
 */

import type { TuiDocument } from "@tui-designer/core";
import type { DocHandle } from "../ports/file-store.js";

export const DISCARD_CHANGES_PROMPT =
  "This document has unsaved changes. Replace it and discard those changes?";

interface ReplacementOptions {
  readonly dirty?: boolean;
  readonly modifiedAt?: number | null;
}

export interface ReplacementPolicyDeps {
  /** Includes an open typing/drawing scratch, which is not dirty in the store yet. */
  readonly hasUnsavedChanges: () => boolean;
  readonly confirmDiscard: (message: string) => boolean;
  /** Flushes typing deliberately and cancels any pointer gesture. */
  readonly settleInteractions: () => void;
  /** Clears document-relative UI state only after replacement was accepted. */
  readonly clearTransientState: () => void;
  readonly adopt: (doc: TuiDocument, handle: DocHandle | null, opts?: ReplacementOptions) => void;
}

export interface ReplacementPolicy {
  replace(doc: TuiDocument, handle: DocHandle | null, opts?: ReplacementOptions): boolean;
}

export function createReplacementPolicy(deps: ReplacementPolicyDeps): ReplacementPolicy {
  return {
    replace(doc, handle, opts) {
      if (deps.hasUnsavedChanges() && !deps.confirmDiscard(DISCARD_CHANGES_PROMPT)) return false;

      // Do not move either call above the confirmation. A declined replacement must
      // leave even transient editing state exactly as the user had it.
      deps.settleInteractions();
      deps.clearTransientState();
      deps.adopt(doc, handle, opts);
      return true;
    },
  };
}
