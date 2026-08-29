/**
 * The undo chokepoint.
 *
 * The spec's hard rule is "one *gesture* = one history entry", and it flags this
 * as the thing implementers get wrong. The goal here is therefore not to be
 * correct by discipline but to make the incorrect version **fail to compile**.
 *
 * `CommittedDoc` is a `TuiDocument` branded with a private symbol. Since
 * `documentStore.commit` accepts only a `CommittedDoc`, a tool that tries the
 * obvious thing:
 *
 * ```ts
 * store.commit(drawBox(present, ...))   // ✗ Type 'TuiDocument' is not
 *                                       //   assignable to 'CommittedDoc'
 * ```
 *
 * …cannot typecheck. The only way to obtain the brand is {@link sealCommit},
 * which `scripts/check-arch.ts` restricts to `src/gestures/**`. Combined with
 * `GestureEffect` having no "push history" variant at all, a tool literally
 * cannot push per pointer-move.
 *
 * The brand is erased at runtime — this costs nothing in the built output.
 */

import type { TuiDocument } from "@tui-designer/core";

declare const COMMITTED: unique symbol;

/** A document that has come out of a *completed* gesture. */
export type CommittedDoc = TuiDocument & { readonly [COMMITTED]: true };

/**
 * Brands a document as the result of a finished gesture.
 *
 * Call sites are limited to the gesture machinery: the reducer on pointer-up or a
 * terminal key, and the typing-burst flusher in G3. Anywhere else is a bug that
 * `pnpm check:arch` will fail on.
 */
export function sealCommit(doc: TuiDocument): CommittedDoc {
  return doc as CommittedDoc;
}
