import { useMemo, useState } from "react";
import {
  type ShortcutId,
  type ShortcutPlatform,
  shortcutConflicts,
  shortcutHints,
  shortcutsByGroup,
} from "../shortcuts.js";
import { Modal } from "./Modal.js";

export interface ShortcutHelpDialogProps {
  readonly platform: ShortcutPlatform;
  readonly disabledReason: (id: ShortcutId) => string | null;
  readonly onClose: () => void;
}

/**
 * Searchable command help generated entirely from the executable registry.
 *
 * The dialog deliberately receives only current disabled reasons from App. All
 * labels, grouping, contexts, bindings, and general availability explanations
 * stay beside the commands they describe in `shortcuts.ts`.
 */
export function ShortcutHelpDialog({
  platform,
  disabledReason,
  onClose,
}: ShortcutHelpDialogProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const conflicts = shortcutConflicts();
  const normalized = query.trim().toLocaleLowerCase();
  const groups = useMemo(
    () =>
      shortcutsByGroup()
        .map(({ group, items }) => ({
          group,
          items: items.filter((shortcut) => {
            if (normalized === "") return true;
            const haystack = [
              shortcut.label,
              shortcut.group,
              shortcut.context,
              shortcut.unavailableWhen,
              ...shortcutHints(shortcut, platform),
            ]
              .join(" ")
              .toLocaleLowerCase();
            return haystack.includes(normalized);
          }),
        }))
        .filter(({ items }) => items.length > 0),
    [normalized, platform],
  );
  const resultCount = groups.reduce((count, group) => count + group.items.length, 0);

  return (
    <Modal title="Keyboard shortcuts" onDismiss={onClose} className="shortcut-help">
      <label className="modal-field">
        Search commands
        <input
          data-initial-focus
          type="search"
          placeholder="Try “layer”, “save”, or “Ctrl”"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <p className="shortcut-summary" role="status" aria-live="polite">
        {resultCount} {resultCount === 1 ? "command" : "commands"}
      </p>

      {conflicts.length > 0 && (
        <p className="notice" role="alert">
          {conflicts.length} conflicting {conflicts.length === 1 ? "binding" : "bindings"} detected.
          Resolve them in the shortcut registry before release.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="shortcut-empty">No commands match “{query.trim()}”.</p>
      ) : (
        <div className="shortcut-groups">
          {groups.map(({ group, items }) => (
            <div key={group} className="shortcut-group">
              <h3>{group}</h3>
              <ul>
                {items.map((shortcut) => {
                  const reason = disabledReason(shortcut.id);
                  return (
                    <li key={shortcut.id} className={reason === null ? undefined : "disabled"}>
                      <div className="shortcut-command">
                        <strong>{shortcut.label}</strong>
                        <span>{shortcut.context}</span>
                      </div>
                      <div className="shortcut-keys">
                        {shortcutHints(shortcut, platform).map((hint) => (
                          <kbd key={hint}>{hint}</kbd>
                        ))}
                      </div>
                      <div className="shortcut-note">
                        {reason === null ? (
                          <>Unavailable when: {shortcut.unavailableWhen}</>
                        ) : (
                          <>
                            <strong>Currently unavailable:</strong> {reason}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
