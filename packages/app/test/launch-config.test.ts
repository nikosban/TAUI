import { describe, expect, it } from "vitest";
import { DEFAULT_LAUNCH_CONFIG, parseLaunchConfig } from "../src/launch-config.js";

describe("parseLaunchConfig", () => {
  it("returns complete defaults for an empty query", () => {
    expect(parseLaunchConfig("")).toEqual(DEFAULT_LAUNCH_CONFIG);
  });

  it("accepts every supported setting", () => {
    expect(
      parseLaunchConfig(
        "?template=form&font=JetBrains+Mono&size=20&lh=1.35&zoom=2&grid=0&tool=text&store=memory",
      ),
    ).toEqual({
      template: "form",
      font: "JetBrains Mono",
      fontSize: 20,
      lineHeightFactor: 1.35,
      zoom: 2,
      showGrid: false,
      tool: "text",
      store: "memory",
    });
  });

  it("accepts each template, tool, store, and grid enum member", () => {
    for (const template of ["dashboard", "form", "file-manager", "empty"]) {
      expect(parseLaunchConfig(`?template=${template}`).template).toBe(template);
    }
    for (const tool of ["pencil", "box", "line", "text", "select", "fill", "eyedropper"]) {
      expect(parseLaunchConfig(`?tool=${tool}`).tool).toBe(tool);
    }
    for (const store of ["auto", "memory"]) {
      expect(parseLaunchConfig(`?store=${store}`).store).toBe(store);
    }
    expect(parseLaunchConfig("?grid=1").showGrid).toBe(true);
    expect(parseLaunchConfig("?grid=0").showGrid).toBe(false);
  });

  it("uses safe defaults for unknown enum members instead of throwing", () => {
    expect(
      parseLaunchConfig("?template=missing&tool=delete-everything&store=opfs&grid=false"),
    ).toEqual(DEFAULT_LAUNCH_CONFIG);
  });

  it("rejects non-finite, empty, malformed, and out-of-range numbers", () => {
    const invalid = ["NaN", "Infinity", "-Infinity", "", " ", "12px", "1e999"];
    for (const value of invalid) {
      const parsed = parseLaunchConfig(
        `?size=${encodeURIComponent(value)}&lh=${value}&zoom=${value}`,
      );
      expect(parsed.fontSize).toBe(DEFAULT_LAUNCH_CONFIG.fontSize);
      expect(parsed.lineHeightFactor).toBe(DEFAULT_LAUNCH_CONFIG.lineHeightFactor);
      expect(parsed.zoom).toBe(DEFAULT_LAUNCH_CONFIG.zoom);
    }
    expect(parseLaunchConfig("?size=7&lh=.99&zoom=.49")).toEqual(DEFAULT_LAUNCH_CONFIG);
    expect(parseLaunchConfig("?size=41&lh=3.01&zoom=4.01")).toEqual(DEFAULT_LAUNCH_CONFIG);
  });

  it("accepts numeric boundary values", () => {
    const low = parseLaunchConfig("?size=8&lh=1&zoom=.5");
    expect([low.fontSize, low.lineHeightFactor, low.zoom]).toEqual([8, 1, 0.5]);
    const high = parseLaunchConfig("?size=40&lh=3&zoom=4");
    expect([high.fontSize, high.lineHeightFactor, high.zoom]).toEqual([40, 3, 4]);
  });

  it("rejects empty, overlong, control-containing, and bidi-spoofed font names", () => {
    for (const font of ["", " ", "A".repeat(101), "Menlo\u0000evil", "Menlo\u202Eevil"]) {
      expect(parseLaunchConfig(`?font=${encodeURIComponent(font)}`).font).toBe(
        DEFAULT_LAUNCH_CONFIG.font,
      );
    }
  });
});
