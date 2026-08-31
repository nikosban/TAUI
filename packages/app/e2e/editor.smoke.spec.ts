import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const EMPTY_EDITOR = "/?template=empty&font=monospace&size=16&lh=1&zoom=1&grid=0&tool=box";

async function openEditor(page: Page, store: "auto" | "memory" = "memory"): Promise<void> {
  await page.goto(`${EMPTY_EDITOR}&store=${store}`);
  await expect
    .poll(() => page.evaluate(() => typeof window.__tui), { message: "development hook installed" })
    .toBe("object");
  await expect
    .poll(async () => (await page.locator("canvas").boundingBox())?.width ?? 0, {
      message: "canvas viewport measured",
    })
    .toBeGreaterThan(1_000);
}

async function point(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const center = await page.evaluate(
    ([targetRow, targetCol]) => window.__tui?.cellCenter(targetRow, targetCol) ?? null,
    [row, col] as const,
  );
  if (center === null) throw new Error(`Cell ${row},${col} is not reachable`);
  return center;
}

async function dragCells(
  page: Page,
  from: readonly [row: number, col: number],
  to: readonly [row: number, col: number],
): Promise<void> {
  const start = await point(page, ...from);
  const end = await point(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

async function text(page: Page): Promise<string> {
  return page.evaluate(() => window.__tui?.toText() ?? "");
}

async function renderedText(page: Page): Promise<string> {
  return page.evaluate(() => window.__tui?.renderedText() ?? "");
}

function segment(snapshot: string, row: number, from: number, to: number): string {
  return (snapshot.split("\n")[row] ?? "").padEnd(to, " ").slice(from, to);
}

async function typeAt(page: Page, row: number, col: number, value: string): Promise<void> {
  await page.keyboard.press("t");
  const at = await point(page, row, col);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.type(value);
  await page.keyboard.press("Escape");
}

async function saveAs(page: Page, name: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+s");
  const dialog = page.getByRole("dialog", { name: "Save as" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "File name" }).fill(name);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("footer").getByText(`${name}.tui`, { exact: true })).toBeVisible();
  await expect(page.getByText("○ saved")).toBeVisible();
}

test("keeps modal focus contained and exposes keyboard layer controls", async ({ page }) => {
  await openEditor(page);

  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.press("ControlOrMeta+Shift+s");
  const dialog = page.getByRole("dialog", { name: "Save as" });
  const name = dialog.getByRole("textbox", { name: "File name" });
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(name).toBeFocused();
  for (const selector of [".app > header", ".app > .workspace", ".app > footer"]) {
    await expect(page.locator(selector)).toHaveAttribute("inert", "");
  }

  await name.press("Shift+Tab");
  await expect(save).toBeFocused();
  await save.press("Tab");
  await expect(name).toBeFocused();
  await name.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(zoomIn).toBeFocused();

  const layers = page.getByRole("region", { name: "Layers" });
  await layers.getByRole("button", { name: "+ add" }).click();
  let layerRows = layers.getByRole("button", { name: /layer \d+ of \d+/u });
  const addedLabel = await layerRows.first().getAttribute("aria-label");
  await layerRows.first().press("ArrowDown");
  layerRows = layers.getByRole("button", { name: /layer \d+ of \d+/u });
  expect(await layerRows.nth(1).getAttribute("aria-label")).toContain(
    addedLabel?.split(",")[0] ?? "Layer",
  );
  await layerRows.nth(1).press("F2");
  await expect(layers.getByRole("textbox", { name: /Rename/u })).toBeFocused();
});

async function openDocument(page: Page, name: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+o");
  const dialog = page.getByRole("dialog", { name: "Open" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name }).click();
}

test("draws box and line gestures and cancels a pointer preview", async ({ page }) => {
  await openEditor(page);

  await dragCells(page, [1, 1], [4, 6]);
  let rows = (await text(page)).split("\n");
  expect(rows[1]?.slice(1, 7)).toBe("┌────┐");
  expect(rows[4]?.slice(1, 7)).toBe("└────┘");

  await page.keyboard.press("l");
  await dragCells(page, [7, 2], [7, 10]);
  rows = (await text(page)).split("\n");
  expect(rows[7]?.slice(2, 11)).toBe("╶───────╴");

  await page.keyboard.press("b");
  const committed = await text(page);
  const revision = await page.evaluate(() => window.__tui?.revision() ?? -1);
  const start = await point(page, 10, 2);
  const end = await point(page, 13, 8);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 });
  expect(await renderedText(page)).not.toBe(committed);
  await page.locator("canvas").dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: end.x,
    clientY: end.y,
  });
  await page.mouse.up();

  await expect.poll(() => renderedText(page)).toBe(committed);
  expect(await page.evaluate(() => window.__tui?.revision() ?? -1)).toBe(revision);
});

test("types, moves, copies, cuts, pastes, undoes, redoes, and cancels paste", async ({ page }) => {
  await openEditor(page);
  await typeAt(page, 2, 2, "ABC");
  await expect(page.getByText("sel 1×3")).toBeVisible();

  await dragCells(page, [2, 2], [4, 5]);
  let rows = (await text(page)).split("\n");
  expect(rows[4]?.slice(5, 8)).toBe("ABC");
  expect(segment(await text(page), 2, 2, 5)).toBe("   ");

  await page.keyboard.press("ControlOrMeta+c");
  const pasteAt = await point(page, 8, 10);
  await page.mouse.move(pasteAt.x, pasteAt.y);
  await page.keyboard.press("ControlOrMeta+v");
  await page.mouse.click(pasteAt.x, pasteAt.y);
  rows = (await text(page)).split("\n");
  expect(rows[8]?.slice(10, 13)).toBe("ABC");

  await page.keyboard.press("ControlOrMeta+z");
  expect(segment(await text(page), 8, 10, 13)).toBe("   ");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect((await text(page)).split("\n")[8]?.slice(10, 13)).toBe("ABC");

  await page.keyboard.press("ControlOrMeta+x");
  expect(segment(await text(page), 8, 10, 13)).toBe("   ");
  expect((await text(page)).split("\n")[4]?.slice(5, 8)).toBe("ABC");
  await page.keyboard.press("ControlOrMeta+z");
  expect((await text(page)).split("\n")[8]?.slice(10, 13)).toBe("ABC");

  await page.keyboard.press("ControlOrMeta+c");
  const cancelledAt = await point(page, 12, 12);
  await page.mouse.move(cancelledAt.x, cancelledAt.y);
  const beforeCancel = await text(page);
  await page.keyboard.press("ControlOrMeta+v");
  expect(await renderedText(page)).not.toBe(beforeCancel);
  await page.keyboard.press("Escape");
  expect(await text(page)).toBe(beforeCancel);
});

test("saves through OPFS, survives reload, opens files, and honors dirty guards", async ({
  page,
}) => {
  await openEditor(page, "auto");
  await typeAt(page, 1, 1, "ALPHA");
  await saveAs(page, "alpha");

  await page.getByRole("combobox", { name: "template" }).selectOption("form");
  await expect.poll(() => text(page)).toContain("new connection");
  await saveAs(page, "beta");

  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof window.__tui)).toBe("object");
  await openDocument(page, "alpha.tui");
  await expect.poll(() => text(page)).toContain("ALPHA");

  await typeAt(page, 3, 1, "dirty");
  const dirtyAlpha = await text(page);
  await page.keyboard.press("ControlOrMeta+o");
  const rejectedOpen = page.waitForEvent("dialog").then(async (dialog) => {
    await dialog.dismiss();
    return dialog.message();
  });
  await page
    .getByRole("dialog", { name: "Open" })
    .getByRole("button", { name: "beta.tui" })
    .click();
  expect(await rejectedOpen).toContain("unsaved changes");
  await expect.poll(() => text(page)).toBe(dirtyAlpha);

  await page.keyboard.press("ControlOrMeta+o");
  const acceptedOpen = page.waitForEvent("dialog").then(async (dialog) => {
    await dialog.accept();
    return dialog.message();
  });
  await page
    .getByRole("dialog", { name: "Open" })
    .getByRole("button", { name: "beta.tui" })
    .click();
  expect(await acceptedOpen).toContain("unsaved changes");
  await expect.poll(() => text(page)).toContain("new connection");

  await typeAt(page, 9, 1, "guard");
  const dirtyBeta = await text(page);
  const templateGuard = page.waitForEvent("dialog").then(async (dialog) => {
    await dialog.dismiss();
    return dialog.message();
  });
  await page.getByRole("combobox", { name: "template" }).selectOption("dashboard");
  expect(await templateGuard).toContain("unsaved changes");
  await expect.poll(() => text(page)).toBe(dirtyBeta);
  await expect(page.getByRole("combobox", { name: "template" })).toHaveValue("empty");

  await page.keyboard.press("ControlOrMeta+Shift+s");
  await page
    .getByRole("dialog", { name: "Save as" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByText("● unsaved")).toBeVisible();
});

test("writes, dismisses, and restores an OPFS recovery without waiting for a timer", async ({
  page,
}) => {
  await openEditor(page, "auto");
  await typeAt(page, 2, 2, "RECOVER");
  await page.evaluate(() => window.__tui?.autosave());

  await page.reload();
  let recovery = page.getByRole("dialog", { name: "Recover unsaved work" });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "Not now" }).click();
  await expect(recovery).toBeHidden();
  expect(await text(page)).not.toContain("RECOVER");

  await page.reload();
  recovery = page.getByRole("dialog", { name: "Recover unsaved work" });
  await expect(recovery).toBeVisible();
  await recovery.locator(".recovery-restore").click();
  await expect.poll(() => text(page)).toContain("RECOVER");
  await expect(page.getByText("● unsaved")).toBeVisible();
});

test("downloads every export format and reports PNG encoding failure", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "foreground ansi 1", exact: true }).click();
  await typeAt(page, 2, 2, "EXPORT");
  await saveAs(page, "artifact");

  const formats = [
    { button: "ANSI", extension: "ans" },
    { button: "Plain text", extension: "txt" },
    { button: "SVG", extension: "svg" },
    { button: "PNG", extension: "png" },
  ] as const;

  for (const format of formats) {
    await page.keyboard.press("ControlOrMeta+e");
    const dialog = page.getByRole("dialog", { name: "Export" });
    await dialog.getByRole("button", { name: format.button }).click();
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`artifact.${format.extension}`);
    const path = await download.path();
    if (path === null) throw new Error(`${format.button} download has no local path`);
    const bytes = await readFile(path);
    expect(bytes.byteLength).toBeGreaterThan(8);
    if (format.extension === "ans") expect(bytes.toString("utf8")).toContain("\u001b[");
    if (format.extension === "txt") expect(bytes.toString("utf8")).toContain("EXPORT");
    if (format.extension === "svg") expect(bytes.toString("utf8")).toContain("<svg");
    if (format.extension === "png") {
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  }

  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.keyboard.press("ControlOrMeta+e");
  await page
    .getByRole("dialog", { name: "Export" })
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(downloads).toBe(0);

  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function refuseBlob(callback): void {
      callback(null);
    };
  });
  await page.keyboard.press("ControlOrMeta+e");
  const failed = page.getByRole("dialog", { name: "Export" });
  await failed.getByRole("button", { name: "PNG" }).click();
  await failed.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText(/Export failed: the browser refused to encode/u)).toBeVisible();
  await expect(failed).toBeVisible();
});
