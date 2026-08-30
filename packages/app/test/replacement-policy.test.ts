import { createDocument, sequentialIdGen } from "@tui-designer/core";
import { describe, expect, it, vi } from "vitest";
import {
  createReplacementPolicy,
  DISCARD_CHANGES_PROMPT,
} from "../src/files/replacement-policy.js";

const document = () => createDocument(8, 4, { idGen: sequentialIdGen() });

function harness({ unsaved = false, confirm = true } = {}) {
  const calls: string[] = [];
  const adopt = vi.fn();
  const confirmDiscard = vi.fn(() => confirm);
  const policy = createReplacementPolicy({
    hasUnsavedChanges: () => unsaved,
    confirmDiscard,
    settleInteractions: () => calls.push("settle"),
    clearTransientState: () => calls.push("clear"),
    adopt: (...args) => {
      calls.push("adopt");
      adopt(...args);
    },
  });
  return { policy, calls, adopt, confirmDiscard };
}

describe("document replacement policy", () => {
  it("adopts a replacement directly when the current document is clean", () => {
    const h = harness();
    const next = document();

    expect(h.policy.replace(next, null)).toBe(true);
    expect(h.confirmDiscard).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["settle", "clear", "adopt"]);
    expect(h.adopt).toHaveBeenCalledWith(next, null, undefined);
  });

  it("prompts before changing any state when work would be discarded", () => {
    const h = harness({ unsaved: true, confirm: true });

    expect(h.policy.replace(document(), null)).toBe(true);
    expect(h.confirmDiscard).toHaveBeenCalledWith(DISCARD_CHANGES_PROMPT);
    expect(h.calls).toEqual(["settle", "clear", "adopt"]);
  });

  it("preserves the document and every transient when replacement is declined", () => {
    const h = harness({ unsaved: true, confirm: false });

    expect(h.policy.replace(document(), null)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.adopt).not.toHaveBeenCalled();
  });

  it("forwards recovery dirty state to the adopted document", () => {
    const h = harness();
    const next = document();

    expect(h.policy.replace(next, null, { dirty: true })).toBe(true);
    expect(h.adopt).toHaveBeenCalledWith(next, null, { dirty: true });
  });
});
