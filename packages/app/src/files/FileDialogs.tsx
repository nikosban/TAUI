/**
 * The two modal dialogs the file layer needs.
 *
 * OPFS has no native picker, so the app supplies one; the `PickerFn` contract is
 * promise-based, which the {@link usePicker} hook bridges by parking the resolver
 * in state until the user answers.
 *
 * Both dialogs are markup only. Every decision — which snapshots are worth
 * offering, what a restore does to the handle — is in `ports/file-actions.ts`.
 */

import { useEffect, useRef, useState } from "react";
import type { DocHandle, PickerFn, RecoveryInfo } from "../ports/file-store.js";
import { filenameProblem } from "../safe-filename.js";

export interface PickerRequest {
  readonly entries: readonly DocHandle[];
  readonly mode: "open" | "save";
  readonly suggestedName: string;
  readonly resolve: (choice: DocHandle | string | null) => void;
}

export interface PickerController {
  readonly picker: PickerFn;
  /** Settles an owned request during unmount instead of orphaning its promise. */
  cancelPending(): void;
}

/**
 * Owns the one outstanding picker promise.
 *
 * A second request is rejected with the port's normal cancellation value; it
 * never replaces the first resolver. Keeping this independent of React makes the
 * promise lifecycle directly testable.
 */
export function createPickerController(
  publish: (request: PickerRequest | null) => void,
): PickerController {
  let active: PickerRequest | null = null;

  const picker: PickerFn = (entries, mode, suggestedName) =>
    new Promise((resolve) => {
      if (active !== null) {
        resolve(null);
        return;
      }

      const request: PickerRequest = {
        entries,
        mode,
        suggestedName: suggestedName ?? "untitled.tui",
        resolve: (choice) => {
          // Double clicks and stale rendered buttons are harmless. Only the
          // request that currently owns the gate may settle it.
          if (active !== request) return;
          active = null;
          publish(null);
          resolve(choice);
        },
      };
      active = request;
      publish(request);
    });

  return {
    picker,
    cancelPending() {
      active?.resolve(null);
    },
  };
}

/**
 * A `PickerFn` backed by a React dialog.
 *
 * Returns the function to hand the store plus the state the dialog renders from.
 * The promise stays pending until the user chooses, which is exactly the port's
 * contract — cancellation is a `null` choice, which the adapter turns into a
 * `FileStoreError`.
 */
export function usePicker(): { picker: PickerFn; request: PickerRequest | null } {
  const [request, setRequest] = useState<PickerRequest | null>(null);
  const controller = useRef<PickerController | null>(null);
  if (controller.current === null) controller.current = createPickerController(setRequest);

  useEffect(() => () => controller.current?.cancelPending(), []);

  return { picker: controller.current.picker, request };
}

export function PickerDialog({ request }: { request: PickerRequest }): React.JSX.Element {
  const [name, setName] = useState(request.suggestedName);
  const saving = request.mode === "save";
  const nameError = saving ? filenameProblem(name) : null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={saving ? "Save as" : "Open"}
      >
        <h2>{saving ? "Save as" : "Open"}</h2>

        {saving && (
          <label className="modal-field">
            File name
            <input
              // biome-ignore lint/a11y/noAutofocus: a modal that needs a name should accept typing immediately
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameError === null) request.resolve(name.trim());
                if (e.key === "Escape") request.resolve(null);
                e.stopPropagation();
              }}
            />
            {nameError !== null && <span className="warn small">{nameError}</span>}
          </label>
        )}

        {request.entries.length === 0 ? (
          <p className="muted small">
            {saving ? "No documents yet." : "No documents in browser storage yet."}
          </p>
        ) : (
          <ul className="modal-list">
            {request.entries.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => request.resolve(saving ? entry.key : entry)}
                  title={entry.display}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button type="button" className="chip" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          {saving && (
            <button
              type="button"
              className="chip active"
              disabled={nameError !== null}
              onClick={() => request.resolve(name.trim())}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export interface RecoveryDialogProps {
  readonly snapshots: readonly RecoveryInfo[];
  readonly now: number;
  readonly onRestore: (info: RecoveryInfo) => void;
  readonly onDiscardAll: () => void;
  readonly onDismiss: () => void;
}

/**
 * A snapshot's document name, as a person would read it.
 *
 * A never-saved document autosaves under a synthetic
 * `untitled-<epoch ms>-<generation>` key — stable per document generation, which
 * makes its snapshots accumulate without mixing two unsaved documents. Those
 * numbers are implementation details and should not appear in the prompt.
 */
export function recoveryLabel(key: string): string {
  // Accept the pre-generation form too, so recoveries written by an earlier
  // version keep the same friendly label after upgrading.
  return /^untitled-\d+(?:-\d+)?$/u.test(key) ? "Unsaved document" : key;
}

/**
 * "How long ago", in the coarsest useful unit.
 *
 * Relative rather than absolute because the question being answered is "is this
 * the work I just lost?", and a wall-clock time makes the reader do the
 * subtraction.
 */
export function relativeTime(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function RecoveryDialog({
  snapshots,
  now,
  onRestore,
  onDiscardAll,
  onDismiss,
}: RecoveryDialogProps): React.JSX.Element {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Recover unsaved work">
        <h2>Unsaved work found</h2>
        <p className="muted small">
          These snapshots are newer than the file they came from. Restoring one loads it as a new
          unsaved document, so the file on disk is left alone until you save.
        </p>

        <ul className="modal-list recovery-list">
          {snapshots.map((info) => (
            <li key={info.id}>
              <button type="button" onClick={() => onRestore(info)} title={info.handle.display}>
                <span className="recovery-name">{recoveryLabel(info.handle.key)}</span>
                <span className="recovery-age">{relativeTime(info.recoveredAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <button type="button" className="chip" onClick={onDismiss}>
            Not now
          </button>
          <button type="button" className="chip danger" onClick={onDiscardAll}>
            Discard all
          </button>
        </div>
      </div>
    </div>
  );
}
