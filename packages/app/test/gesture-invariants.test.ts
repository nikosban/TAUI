/**
 * Property tests for the four gesture invariants.
 *
 * These are the reason the reducer is pure: each invariant is checked by driving
 * generated event sequences through every tool and every state, which is not
 * something you can do against a reducer that reaches into stores.
 */

import { createDocument, sequentialIdGen, type TuiDocument } from "@tui-designer/core";
import { describe, expect, it } from "vitest";
import type { CellPos } from "../src/canvas/metrics.js";
import {
  type GestureContext,
  type GestureEffect,
  type GestureEvent,
  type GestureState,
  IDLE,
  type Modifiers,
  NO_MODS,
  reduceGesture,
  type ToolId,
} from "../src/gestures/gesture.js";

const TOOLS: readonly ToolId[] = ["pencil", "box", "line", "text", "select", "fill", "eyedropper"];

/** Tools that actually run a pointer gesture at G2. */
const DRAWING_TOOLS: readonly ToolId[] = ["pencil", "box", "line", "select"];

function context(overrides: Partial<GestureContext> = {}): GestureContext {
  const base = createDocument(12, 6, { idGen: sequentialIdGen() });
  return {
    base,
    layerId: base.activeLayerId,
    brush: { char: "#", fg: { kind: "default" }, bg: { kind: "default" } },
    lineStyle: "light",
    selection: null,
    clipboard: null,
    hover: null,
    ...overrides,
  };
}

const at = (row: number, col: number): CellPos => ({ row, col });

const down = (cell: CellPos, mods: Modifiers = NO_MODS): GestureEvent => ({
  t: "down",
  cell,
  mods,
  button: 0,
});
const move = (cell: CellPos, mods: Modifiers = NO_MODS): GestureEvent => ({
  t: "move",
  cell,
  mods,
});
const up = (cell: CellPos, mods: Modifiers = NO_MODS): GestureEvent => ({ t: "up", cell, mods });
const cancel: GestureEvent = { t: "cancel" };

/** Runs a sequence, collecting every effect emitted along the way. */
function run(
  tool: ToolId,
  events: readonly GestureEvent[],
  ctx: GestureContext,
): { state: GestureState; effects: GestureEffect[]; steps: GestureState[] } {
  let state: GestureState = IDLE;
  const effects: GestureEffect[] = [];
  const steps: GestureState[] = [];
  for (const event of events) {
    const step = reduceGesture(tool, state, event, ctx);
    state = step.state;
    effects.push(...step.effects);
    steps.push(state);
  }
  return { state, effects, steps };
}

const commits = (effects: readonly GestureEffect[]) => effects.filter((e) => e.t === "commit");

/** A deterministic pseudo-random sequence generator — no Math.random. */
function* sequences(count: number): Generator<GestureEvent[]> {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < count; i++) {
    const events: GestureEvent[] = [down(at(next(6), next(12)))];
    const moves = next(5);
    for (let m = 0; m < moves; m++) {
      const mods: Modifiers = { ...NO_MODS, shift: next(2) === 0, alt: next(2) === 0 };
      events.push(move(at(next(6), next(12)), mods));
    }
    const ending = next(3);
    if (ending === 0) events.push(up(at(next(6), next(12))));
    else if (ending === 1) events.push(cancel);
    // ending 2: sequence just stops mid-drag.
    yield events;
  }
}

describe("invariant 1: commit never happens on a move", () => {
  it("holds for every tool, every state, every move event", () => {
    for (const tool of TOOLS) {
      for (const ctx of [
        context(),
        context({ selection: { top: 1, left: 1, rows: 3, cols: 3 } }),
      ]) {
        // Reach a mid-gesture state first, then assert every subsequent move.
        let state = reduceGesture(tool, IDLE, down(at(1, 1)), ctx).state;
        for (let i = 0; i < 6; i++) {
          const step = reduceGesture(tool, state, move(at(i % 5, i)), ctx);
          expect(
            commits(step.effects),
            `${tool} committed on move from state ${state.kind}`,
          ).toEqual([]);
          state = step.state;
        }
      }
    }
  });

  it("holds across generated sequences", () => {
    for (const tool of DRAWING_TOOLS) {
      for (const events of sequences(40)) {
        let state: GestureState = IDLE;
        for (const event of events) {
          const step = reduceGesture(tool, state, event, context());
          if (event.t === "move") {
            expect(commits(step.effects), `${tool} committed on move`).toEqual([]);
          }
          state = step.state;
        }
      }
    }
  });
});

describe("invariant 2: every op derives from ctx.base", () => {
  it("makes move idempotent — replaying the same move gives the same scratch", () => {
    for (const tool of DRAWING_TOOLS) {
      const ctx = context({ selection: { top: 1, left: 1, rows: 2, cols: 2 } });
      const afterDown = reduceGesture(tool, IDLE, down(at(1, 1)), ctx);
      const first = reduceGesture(tool, afterDown.state, move(at(4, 8)), ctx);
      const second = reduceGesture(tool, first.state, move(at(4, 8)), ctx);

      const scratchOf = (effects: readonly GestureEffect[]): TuiDocument | null => {
        const found = effects.find((e) => e.t === "scratch");
        return found?.t === "scratch" ? found.doc : null;
      };
      const a = scratchOf(first.effects);
      const b = scratchOf(second.effects);
      if (a !== null && b !== null) expect(b, `${tool} move is not idempotent`).toEqual(a);
    }
  });

  it("never grows the document by chaining previews", () => {
    // Chaining scratch onto scratch would compound cells; deriving from base
    // cannot. Sweeping back and forth must leave only the final shape.
    const ctx = context();
    let state = reduceGesture("box", IDLE, down(at(0, 0)), ctx).state;
    for (const target of [at(3, 3), at(5, 9), at(2, 2), at(3, 3)]) {
      state = reduceGesture("box", state, move(target), ctx).state;
    }
    const final = reduceGesture("box", state, up(at(3, 3)), ctx);
    const committed = commits(final.effects)[0];
    if (committed?.t !== "commit") throw new Error("expected a commit");

    // Same shape drawn in one shot from base.
    const oneShot = reduceGesture(
      "box",
      reduceGesture("box", IDLE, down(at(0, 0)), ctx).state,
      up(at(3, 3)),
      ctx,
    );
    const direct = commits(oneShot.effects)[0];
    if (direct?.t !== "commit") throw new Error("expected a commit");
    expect(committed.doc).toEqual(direct.doc);
  });

  it("re-derives cleanly when Shift is pressed mid-drag", () => {
    // The stroke must not keep off-axis cells painted before Shift went down.
    const ctx = context();
    let state = reduceGesture("pencil", IDLE, down(at(2, 0)), ctx).state;
    state = reduceGesture("pencil", state, move(at(4, 3)), ctx).state;
    const shifted = reduceGesture(
      "pencil",
      state,
      move(at(4, 6), { ...NO_MODS, shift: true }),
      ctx,
    );
    const scratch = shifted.effects.find((e) => e.t === "scratch");
    if (scratch?.t !== "scratch") throw new Error("expected a scratch");

    // Constrained to the horizontal axis of the start cell: only row 2 painted.
    const rows = new Set(
      Object.keys(scratch.doc.layers[0]?.cells ?? {}).map((k) => Number(k.split(",")[0])),
    );
    expect([...rows]).toEqual([2]);
  });
});

describe("invariant 3: at most one commit per down…up", () => {
  it("holds across generated sequences, and is zero for anything cancelled", () => {
    for (const tool of DRAWING_TOOLS) {
      for (const events of sequences(60)) {
        const { effects } = run(tool, events, context());
        const ups = events.filter((e) => e.t === "up").length;
        const cancelled = events.some((e) => e.t === "cancel");

        expect(commits(effects).length, `${tool}: more commits than ups`).toBeLessThanOrEqual(ups);
        if (cancelled) {
          expect(commits(effects), `${tool}: cancelled sequence committed`).toEqual([]);
        }
      }
    }
  });

  it("emits exactly one commit for a normal draw gesture", () => {
    for (const tool of ["pencil", "box", "line"] as const) {
      const { effects } = run(
        tool,
        [down(at(1, 1)), move(at(2, 4)), move(at(3, 6)), up(at(3, 6))],
        context(),
      );
      expect(commits(effects), `${tool}`).toHaveLength(1);
    }
  });

  it("emits no commit for a marquee, which changes no cells", () => {
    const { effects } = run("select", [down(at(1, 1)), move(at(3, 4)), up(at(3, 4))], context());
    expect(commits(effects)).toEqual([]);
    expect(effects.some((e) => e.t === "set-selection")).toBe(true);
  });

  it("emits no commit when the layer is locked, only a lock flash", () => {
    const base = createDocument(8, 4, { idGen: sequentialIdGen() });
    const locked: TuiDocument = {
      ...base,
      layers: base.layers.map((l) => ({ ...l, locked: true })),
    };
    for (const tool of ["pencil", "box", "line"] as const) {
      const { effects } = run(
        tool,
        [down(at(1, 1)), move(at(2, 2)), up(at(2, 2))],
        context({ base: locked, layerId: locked.activeLayerId }),
      );
      expect(commits(effects), tool).toEqual([]);
      expect(
        effects.some((e) => e.t === "flash-lock"),
        tool,
      ).toBe(true);
    }
  });
});

describe("invariant 4: cancel always reverts and returns to idle", () => {
  it("holds from every mid-gesture state, for every tool", () => {
    for (const tool of TOOLS) {
      const ctx = context({ selection: { top: 1, left: 1, rows: 3, cols: 3 } });
      const started = reduceGesture(tool, IDLE, down(at(2, 2)), ctx);
      const cancelled = reduceGesture(tool, started.state, cancel, ctx);

      expect(cancelled.state, `${tool} did not return to idle`).toEqual(IDLE);
      expect(commits(cancelled.effects), `${tool} committed on cancel`).toEqual([]);

      if (started.state.kind === "idle") continue;

      if (started.state.kind === "caret") {
        // The text caret is *dismissed*, not reverted: characters already typed
        // are real edits held by the open burst, which the controller flushes.
        // Reverting would silently throw away what the user typed.
        expect(cancelled.effects, `${tool} should dismiss the caret`).toEqual([
          { t: "set-caret", caret: null },
        ]);
      } else {
        expect(
          cancelled.effects.some((e) => e.t === "revert"),
          `${tool} did not revert`,
        ).toBe(true);
      }
    }
  });

  it("clears any in-progress drag rect", () => {
    const ctx = context();
    const started = reduceGesture("select", IDLE, down(at(1, 1)), ctx);
    const cancelled = reduceGesture("select", started.state, cancel, ctx);
    expect(cancelled.effects).toContainEqual({ t: "drag-rect", rect: null });
  });

  it("is inert when already idle", () => {
    const step = reduceGesture("box", IDLE, cancel, context());
    expect(step.state).toEqual(IDLE);
    expect(step.effects).toEqual([]);
  });
});

describe("the reducer is total", () => {
  it("never throws for any tool/state/event combination", () => {
    const ctx = context({ selection: { top: 0, left: 0, rows: 2, cols: 2 } });
    const states: GestureState[] = [
      IDLE,
      { kind: "pencil", path: [at(0, 0)], axis: null },
      { kind: "box", anchor: at(0, 0), current: at(2, 2), merge: true },
      { kind: "line", anchor: at(0, 0), current: at(2, 2), merge: false },
      { kind: "marquee", anchor: at(0, 0), current: at(1, 1) },
      {
        kind: "move-region",
        rect: { top: 0, left: 0, rows: 2, cols: 2 },
        grab: at(0, 0),
        current: at(1, 1),
        duplicate: false,
      },
    ];
    const events: GestureEvent[] = [
      down(at(1, 1)),
      { t: "down", cell: at(1, 1), mods: NO_MODS, button: 2 },
      move(at(2, 2)),
      up(at(2, 2)),
      cancel,
      { t: "key", key: "Delete", mods: NO_MODS },
      { t: "key", key: "q", mods: NO_MODS },
    ];

    for (const tool of TOOLS) {
      for (const state of states) {
        for (const event of events) {
          expect(
            () => reduceGesture(tool, state, event, ctx),
            `${tool} / ${state.kind} / ${event.t}`,
          ).not.toThrow();
        }
      }
    }
  });

  it("clears the selection on Backspace as well as Delete", () => {
    // Both keys are bound to edit.delete, so both must reach the reducer.
    const ctx = context({ selection: { top: 0, left: 0, rows: 2, cols: 2 } });
    for (const key of ["Delete", "Backspace"]) {
      const step = reduceGesture("select", IDLE, { t: "key", key, mods: NO_MODS }, ctx);
      expect(commits(step.effects), key).toHaveLength(1);
    }
  });

  it("refuses to clear a selection on a locked layer", () => {
    const base = createDocument(8, 4, { idGen: sequentialIdGen() });
    const locked: TuiDocument = {
      ...base,
      layers: base.layers.map((l) => ({ ...l, locked: true })),
    };
    const ctx = context({
      base: locked,
      layerId: locked.activeLayerId,
      selection: { top: 0, left: 0, rows: 2, cols: 2 },
    });
    const step = reduceGesture("select", IDLE, { t: "key", key: "Delete", mods: NO_MODS }, ctx);
    expect(commits(step.effects)).toEqual([]);
    expect(step.effects).toEqual([{ t: "flash-lock" }]);
  });

  it("refuses to move a selection on a locked layer", () => {
    const base = createDocument(8, 4, { idGen: sequentialIdGen() });
    const locked: TuiDocument = {
      ...base,
      layers: base.layers.map((l) => ({ ...l, locked: true })),
    };
    const ctx = context({
      base: locked,
      layerId: locked.activeLayerId,
      selection: { top: 0, left: 0, rows: 2, cols: 2 },
    });
    // Pressing inside the selection would normally start a move-region gesture.
    const step = reduceGesture("select", IDLE, down(at(1, 1)), ctx);
    expect(step.state).toEqual(IDLE);
    expect(step.effects).toEqual([{ t: "flash-lock" }]);
  });

  it("right-click eyedrops from every tool without starting a gesture", () => {
    for (const tool of TOOLS) {
      const step = reduceGesture(
        tool,
        IDLE,
        { t: "down", cell: at(2, 3), mods: NO_MODS, button: 2 },
        context(),
      );
      expect(step.state, tool).toEqual(IDLE);
      expect(step.effects, tool).toEqual([{ t: "set-brush-from-cell", cell: at(2, 3) }]);
    }
  });
});
