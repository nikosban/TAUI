/**
 * The export dialog.
 *
 * Delivery is a browser download rather than a write through the `FileStore` port,
 * and that is deliberate: an export leaves the app for good. Putting an `.svg`
 * inside OPFS — where nothing else can reach it — would be worse than useless,
 * and under Tauri a save dialog is the native equivalent of the same gesture.
 */

import type { TuiDocument } from "@tui-designer/core";
import { useState } from "react";
import { Modal } from "../a11y/Modal.js";
import type { CellMetrics } from "../canvas/metrics.js";
import type { Theme } from "../canvas/paint-plan.js";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  exportAsPng,
  exportAsText,
  exportFilename,
  formatInfo,
} from "./export.js";

/**
 * Hands a blob to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari has
 * historically cancelled the download if the URL dies in the same frame as the
 * click.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface ExportDialogProps {
  readonly doc: TuiDocument;
  readonly documentLabel: string | null;
  readonly metrics: CellMetrics;
  readonly theme: Theme;
  readonly onClose: () => void;
  readonly onError: (message: string) => void;
}

export function ExportDialog({
  doc,
  documentLabel,
  metrics,
  theme,
  onClose,
  onError,
}: ExportDialogProps): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>("svg");
  const [busy, setBusy] = useState(false);
  const info = formatInfo(format);
  const filename = exportFilename(documentLabel, format);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const blob =
        format === "png"
          ? await exportAsPng(doc, { metrics, theme })
          : new Blob([exportAsText(doc, format)], { type: `${info.mime};charset=utf-8` });
      downloadBlob(blob, filename);
      onClose();
    } catch (error) {
      onError(`Export failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export" onDismiss={onClose}>
      <div className="row">
        {EXPORT_FORMATS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === format ? "chip wide active" : "chip wide"}
            onClick={() => setFormat(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <p className="muted small">{info.note}</p>
      <p className="muted small">
        {doc.cols}×{doc.rows} cells → <strong>{filename}</strong>
      </p>

      <div className="modal-actions">
        <button type="button" className="chip" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="chip active" onClick={() => void run()} disabled={busy}>
          {busy ? "Exporting…" : "Export"}
        </button>
      </div>
    </Modal>
  );
}
