import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, usePrefsStore } from "../src/stores/prefs-store.js";

beforeEach(() => {
  usePrefsStore.setState({
    previewFont: DEFAULT_PREFS.previewFont,
    fontSize: DEFAULT_PREFS.fontSize,
    requestedLineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
    lineHeightFactor: DEFAULT_PREFS.lineHeightFactor,
    showGrid: DEFAULT_PREFS.showGrid,
    zoom: DEFAULT_PREFS.zoom,
    coverage: null,
  });
});

describe("numeric preference boundaries", () => {
  it("rejects non-finite font sizes without corrupting existing state", () => {
    const prefs = usePrefsStore.getState();
    prefs.setFontSize(20);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      usePrefsStore.getState().setFontSize(value);
      expect(usePrefsStore.getState().fontSize).toBe(20);
    }
  });

  it("clamps finite font sizes to their supported range", () => {
    usePrefsStore.getState().setFontSize(-100);
    expect(usePrefsStore.getState().fontSize).toBe(8);
    usePrefsStore.getState().setFontSize(1_000);
    expect(usePrefsStore.getState().fontSize).toBe(40);
  });

  it("rejects non-finite line heights and clamps finite requests", () => {
    usePrefsStore.getState().setLineHeightFactor(1.5);
    usePrefsStore.getState().setLineHeightFactor(Number.NaN);
    expect(usePrefsStore.getState().requestedLineHeightFactor).toBe(1.5);
    expect(usePrefsStore.getState().lineHeightFactor).toBe(1.5);

    usePrefsStore.getState().setLineHeightFactor(-1);
    expect(usePrefsStore.getState().requestedLineHeightFactor).toBe(1);
    usePrefsStore.getState().setLineHeightFactor(99);
    expect(usePrefsStore.getState().requestedLineHeightFactor).toBe(3);
  });

  it("rejects non-finite zoom and clamps finite values", () => {
    usePrefsStore.getState().setZoom(2);
    usePrefsStore.getState().setZoom(Number.POSITIVE_INFINITY);
    expect(usePrefsStore.getState().zoom).toBe(2);
    usePrefsStore.getState().setZoom(0);
    expect(usePrefsStore.getState().zoom).toBe(0.5);
    usePrefsStore.getState().setZoom(99);
    expect(usePrefsStore.getState().zoom).toBe(4);
  });
});
