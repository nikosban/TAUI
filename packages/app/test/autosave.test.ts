/**
 * The autosave decision.
 *
 * Pure, with time passed in, so no fake timers. The interesting assertions are the
 * ones about *not* writing: the revision guard is the whole point, and a
 * dirty-only guard would pass every "writes when due" test while flooding the
 * recovery history with duplicates.
 */

import { describe, expect, it } from "vitest";
import {
  AUTOSAVE_INTERVAL_MS,
  type AutosaveInput,
  type AutosaveState,
  autosaveStateAfterSave,
  decideAutosave,
  initialAutosaveState,
} from "../src/ports/autosave.js";

const input = (over: Partial<AutosaveInput> = {}): AutosaveInput => ({
  revision: 1,
  at: AUTOSAVE_INTERVAL_MS,
  busy: false,
  dirty: true,
  ...over,
});

/** State as if a snapshot had been written at revision `rev`, time `at`. */
const wrote = (rev: number, at: number): AutosaveState => ({ lastRevision: rev, lastAt: at });

describe("writing", () => {
  it("writes once the interval has elapsed on a dirty document", () => {
    const decision = decideAutosave(initialAutosaveState(), input());
    expect(decision.t).toBe("write");
  });

  it("carries forward the revision and time it wrote at", () => {
    const decision = decideAutosave(initialAutosaveState(), input({ revision: 7, at: 90_000 }));
    expect(decision).toEqual({ t: "write", state: { lastRevision: 7, lastAt: 90_000 } });
  });

  it("writes again after a further edit and a further interval", () => {
    const first = decideAutosave(initialAutosaveState(), input({ revision: 1, at: 30_000 }));
    expect(first.t).toBe("write");
    const state = first.t === "write" ? first.state : initialAutosaveState();

    const second = decideAutosave(state, input({ revision: 2, at: 60_000 }));
    expect(second.t).toBe("write");
  });

  it("honours a custom interval", () => {
    const decision = decideAutosave(initialAutosaveState(), input({ at: 100 }), {
      intervalMs: 50,
    });
    expect(decision.t).toBe("write");
  });
});

describe("the revision guard", () => {
  it("skips when no edit has landed since the last snapshot", () => {
    // The bug this exists to prevent: a dirty-guarded autosave rewrites an
    // identical blob every interval while the user just reads the screen, and with
    // a rolling history that pushes out the states worth keeping.
    const decision = decideAutosave(wrote(5, 0), input({ revision: 5, at: 999_999 }));
    expect(decision).toEqual({ t: "skip", reason: "unchanged" });
  });

  it("keeps skipping however long the document sits untouched", () => {
    const state = wrote(5, 0);
    for (const at of [30_000, 60_000, 600_000, 86_400_000]) {
      expect(decideAutosave(state, input({ revision: 5, at })).t).toBe("skip");
    }
  });

  it("writes as soon as the revision moves", () => {
    const state = wrote(5, 0);
    expect(decideAutosave(state, input({ revision: 6, at: 30_000 })).t).toBe("write");
  });

  it("treats a revision that moved backwards as a change", () => {
    // Undo lowers the revision in some designs; either way "different" is the
    // question, not "greater".
    expect(decideAutosave(wrote(9, 0), input({ revision: 4, at: 30_000 })).t).toBe("write");
  });
});

describe("skipping", () => {
  it("skips a clean document, because there is nothing to lose", () => {
    expect(decideAutosave(initialAutosaveState(), input({ dirty: false }))).toEqual({
      t: "skip",
      reason: "clean",
    });
  });

  it("reports 'clean' rather than 'unchanged' for a saved document", () => {
    // The more useful reason of the two when both apply.
    const decision = decideAutosave(wrote(3, 0), input({ revision: 3, dirty: false }));
    expect(decision).toEqual({ t: "skip", reason: "clean" });
  });

  it("skips before the interval has elapsed", () => {
    expect(decideAutosave(initialAutosaveState(), input({ at: AUTOSAVE_INTERVAL_MS - 1 }))).toEqual(
      { t: "skip", reason: "interval" },
    );
  });

  it("makes a first snapshot wait out one interval too", () => {
    // A document opened and immediately edited should not snapshot before the user
    // has paused once.
    expect(decideAutosave(initialAutosaveState(), input({ at: 0 })).t).toBe("skip");
  });

  it("skips while a gesture is open, so no half-drawn box becomes a recovery point", () => {
    expect(decideAutosave(initialAutosaveState(), input({ busy: true }))).toEqual({
      t: "skip",
      reason: "busy",
    });
  });

  it("writes on the next tick once the gesture ends", () => {
    const state = initialAutosaveState();
    expect(decideAutosave(state, input({ busy: true })).t).toBe("skip");
    expect(decideAutosave(state, input({ busy: false })).t).toBe("write");
  });

  it("reports 'busy' only when a write would otherwise have happened", () => {
    // Guard order: a busy *and* unchanged document reports the reason that will
    // still be true after the gesture ends.
    const decision = decideAutosave(wrote(2, 0), input({ revision: 2, busy: true }));
    expect(decision).toEqual({ t: "skip", reason: "unchanged" });
  });
});

describe("after an explicit save", () => {
  it("does not immediately snapshot what was just written to disk", () => {
    const state = autosaveStateAfterSave(11, 50_000);
    expect(decideAutosave(state, input({ revision: 11, at: 90_000 }))).toEqual({
      t: "skip",
      reason: "unchanged",
    });
  });

  it("restarts the interval from the save, not from the last autosave", () => {
    const state = autosaveStateAfterSave(11, 50_000);
    // An edit right after the save still waits a full interval.
    expect(decideAutosave(state, input({ revision: 12, at: 60_000 })).t).toBe("skip");
    expect(decideAutosave(state, input({ revision: 12, at: 80_000 })).t).toBe("write");
  });
});

describe("a realistic session", () => {
  it("writes one snapshot per distinct state, not per tick", () => {
    // Four minutes of ticking with two bursts of editing must produce two
    // snapshots, not eight.
    let state = initialAutosaveState();
    let revision = 0;
    const written: number[] = [];

    for (let tick = 0; tick < 8; tick++) {
      const at = tick * AUTOSAVE_INTERVAL_MS;
      // Edits land on ticks 1 and 5 only.
      if (tick === 1 || tick === 5) revision++;
      const decision = decideAutosave(state, { revision, at, busy: false, dirty: revision > 0 });
      if (decision.t === "write") {
        written.push(at);
        state = decision.state;
      }
    }

    expect(written).toHaveLength(2);
  });
});
