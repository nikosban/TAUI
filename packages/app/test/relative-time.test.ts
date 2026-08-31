/**
 * The recovery prompt's age labels.
 *
 * Pure and worth pinning: "is this the work I just lost?" is the question the
 * label answers, and an off-by-one unit makes a six-minute-old snapshot look
 * like yesterday's.
 */

import { describe, expect, it } from "vitest";
import { recoveryLabel, relativeTime } from "../src/files/FileDialogs.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [0, "just now"],
    [30 * SECOND, "just now"],
    [59 * SECOND, "just now"],
    [90 * SECOND, "2 min ago"],
    [6 * MINUTE, "6 min ago"],
    [59 * MINUTE, "59 min ago"],
    [90 * MINUTE, "2 hr ago"],
    [5 * HOUR, "5 hr ago"],
    [26 * HOUR, "1 day ago"],
    [3 * DAY, "3 days ago"],
  ])("renders %i ms ago as %s", (age, expected) => {
    expect(relativeTime(1_000_000 - age + 1_000_000, 1_000_000 + 1_000_000)).toBe(expected);
  });

  it("singularises one day and pluralises the rest", () => {
    expect(relativeTime(0, DAY)).toBe("1 day ago");
    expect(relativeTime(0, 2 * DAY)).toBe("2 days ago");
  });

  it("says 'just now' rather than a negative age for a clock that went backwards", () => {
    // Clock skew is real, and "-3 min ago" reads as a bug.
    expect(relativeTime(2_000_000, 1_000_000)).toBe("just now");
  });
});

describe("recoveryLabel", () => {
  it("hides the synthetic untitled key, which is an implementation detail", () => {
    // "untitled-1787944316037" asks the reader to parse an epoch timestamp.
    expect(recoveryLabel("untitled-1787944316037")).toBe("Unsaved document");
    expect(recoveryLabel("untitled-1787944316037-4")).toBe("Unsaved document");
    expect(recoveryLabel("untitled-0")).toBe("Unsaved document");
  });

  it("shows a real filename unchanged", () => {
    expect(recoveryLabel("my-mockup.tui")).toBe("my-mockup.tui");
  });

  it("does not mistake a real file that merely starts with untitled", () => {
    // A user may genuinely name a document this.
    expect(recoveryLabel("untitled.tui")).toBe("untitled.tui");
    expect(recoveryLabel("untitled-draft.tui")).toBe("untitled-draft.tui");
  });
});
