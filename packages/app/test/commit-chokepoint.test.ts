/**
 * Type-level tests for the undo chokepoint.
 *
 * `@ts-expect-error` is self-verifying: if the expected error ever *stops*
 * happening, the directive itself becomes an error and `pnpm typecheck` fails.
 * So this file guards the compile-time guarantee, not just the runtime behaviour —
 * a plain unit test could not detect the brand being weakened.
 */

import { createDocument, drawBox, sequentialIdGen, type TuiDocument } from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import { type CommittedDoc, sealCommit } from "../src/gestures/commit.js";
import { createDocumentStore } from "../src/stores/document-store.js";

const STYLE = { fg: { kind: "default" }, bg: { kind: "default" } } as const;

function fixture(): TuiDocument {
  return createDocument(10, 4, { idGen: sequentialIdGen() });
}

describe("the commit chokepoint", () => {
  it("rejects the raw result of a draw op", () => {
    const store = createDocumentStore(fixture());
    const present = store.getState().present();
    const drawn = drawBox(
      present,
      present.activeLayerId,
      { top: 0, left: 0, rows: 3, cols: 3 },
      "light",
      true,
      STYLE,
    );

    // The mistake the brand exists to prevent: committing mid-gesture output
    // straight from an op. Must not typecheck.
    // @ts-expect-error - TuiDocument is not assignable to CommittedDoc
    store.getState().commit(drawn);

    // It still *runs* (the brand is erased), which is why the compile-time check
    // is the real guard rather than a runtime assertion.
    expect(store.getState().canUndo()).toBe(true);
  });

  it("rejects an unbranded document, however it was obtained", () => {
    const store = createDocumentStore(fixture());
    const plain: TuiDocument = fixture();
    // @ts-expect-error - a bare TuiDocument carries no commit brand
    store.getState().commit(plain);
    expect(store.getState().canUndo()).toBe(true);
  });

  it("accepts a document sealed by the gesture machinery", () => {
    const store = createDocumentStore(fixture());
    const sealed: CommittedDoc = sealCommit(
      drawBox(
        store.getState().present(),
        store.getState().present().activeLayerId,
        { top: 0, left: 0, rows: 3, cols: 3 },
        "light",
        true,
        STYLE,
      ),
    );
    store.getState().commit(sealed);
    expect(store.getState().canUndo()).toBe(true);
    expect(store.getState().dirty).toBe(true);
  });

  it("brands without altering the document", () => {
    // The brand must be erasable: identical object in, identical object out.
    const doc = fixture();
    expect(sealCommit(doc)).toBe(doc);
  });

  it("a CommittedDoc is still usable as a TuiDocument", () => {
    // The brand narrows what `commit` accepts; it must not infect ordinary use.
    const sealed = sealCommit(fixture());
    const widened: TuiDocument = sealed;
    expect(widened.cols).toBe(10);
  });
});

describe("no-op gestures cannot pollute history", () => {
  it("a sealed no-op adds no undo entry", () => {
    // core returns the identical object for a no-op, and the store checks identity
    // before pushing — so an empty gesture is free even if the reducer commits it.
    const store = createDocumentStore(fixture());
    const present = store.getState().present();
    const unchanged = drawBox(
      present,
      present.activeLayerId,
      { top: 99, left: 99, rows: 2, cols: 2 }, // entirely off-grid
      "light",
      true,
      STYLE,
    );
    expect(unchanged).toBe(present);

    store.getState().commit(sealCommit(unchanged));
    expect(store.getState().canUndo()).toBe(false);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().revision).toBe(0);
  });
});
