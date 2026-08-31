/**
 * In-memory `FileStore`. Built in G1 as the sole implementation.
 *
 * Two jobs: it lets the document store's open/save paths be exercised from day
 * one even though no UI surfaces them until G4, and it is the test double for
 * every file-related test (and, via a URL flag, for Playwright — a smoke test
 * that starts from a known-empty state).
 */

import { safeDocumentFilename } from "../safe-filename.js";
import {
  type Clock,
  type DocHandle,
  type FileStore,
  FileStoreError,
  type OpenResult,
  type PickerFn,
  RECOVERY_HISTORY_LIMIT,
  RECOVERY_STARTUP_BYTES,
  RECOVERY_TOTAL_BYTES,
  RECOVERY_TOTAL_LIMIT,
  type RecentEntry,
  type RecoveryInfo,
  type SavePickerChoice,
} from "./file-store.js";

interface Entry {
  content: string;
  modifiedAt: number;
}

/** One autosave snapshot. The document it belongs to is the map key. */
interface RecoveryEntry {
  readonly id: string;
  readonly content: string;
  readonly savedAt: number;
}

export interface MemoryFileStoreOptions {
  readonly picker?: PickerFn;
  readonly now?: Clock;
  /** Seed documents, keyed by name. */
  readonly initial?: Readonly<Record<string, string>>;
}

export interface MemoryFileStore extends FileStore {
  readonly kind: "memory";
  /** Test inspection: current contents, keyed by document key. */
  snapshot(): Record<string, string>;
  /** Test inspection: every snapshot's content, oldest first, keyed by document. */
  recoverySnapshot(): Record<string, string[]>;
}

const handleFor = (key: string): DocHandle => ({
  key,
  label: safeDocumentFilename(key),
  display: `${safeDocumentFilename(key)} (in memory)`,
});

const isSavePickerChoice = (
  choice: DocHandle | string | SavePickerChoice,
): choice is SavePickerChoice =>
  typeof choice === "object" && choice !== null && "overwrite" in choice && "handle" in choice;

export function createMemoryFileStore(opts: MemoryFileStoreOptions = {}): MemoryFileStore {
  const docs = new Map<string, Entry>();
  /** Per document key, oldest snapshot first. */
  const recoveries = new Map<string, RecoveryEntry[]>();
  let recoverySeq = 0;
  const recent: RecentEntry[] = [];
  let tick = 0;
  const now: Clock = opts.now ?? (() => ++tick);

  for (const [key, content] of Object.entries(opts.initial ?? {})) {
    docs.set(key, { content, modifiedAt: now() });
  }

  const requirePicker = (): PickerFn => {
    if (opts.picker === undefined) {
      throw new FileStoreError("unsupported", "memory store has no picker configured");
    }
    return opts.picker;
  };

  const read = (key: string): Entry => {
    const entry = docs.get(key);
    if (entry === undefined) throw new FileStoreError("not-found", `no such document: ${key}`);
    return entry;
  };

  return {
    kind: "memory",
    capabilities: { nativeDialogs: false, persistent: false, modifiedTimes: true },

    async openWithPicker(): Promise<OpenResult> {
      const chosen = await requirePicker()([...docs.keys()].map(handleFor), "open");
      if (chosen === null) throw new FileStoreError("cancelled", "open cancelled");
      const target = isSavePickerChoice(chosen) ? chosen.handle : chosen;
      const key = typeof target === "string" ? safeDocumentFilename(target) : target.key;
      const entry = read(key);
      return { handle: handleFor(key), content: entry.content, modifiedAt: entry.modifiedAt };
    },

    async openHandle(handle) {
      const entry = read(handle.key);
      return {
        handle: handleFor(handle.key),
        content: entry.content,
        modifiedAt: entry.modifiedAt,
      };
    },

    async save(handle, content, options) {
      const current = docs.get(handle.key);
      if (
        options?.force !== true &&
        options?.expectedModifiedAt !== undefined &&
        (current?.modifiedAt ?? null) !== options.expectedModifiedAt
      ) {
        throw new FileStoreError("conflict", `${handle.label} changed since it was opened`);
      }
      const modifiedAt = now();
      docs.set(handle.key, { content, modifiedAt });
      return { modifiedAt };
    },

    async saveAs(content, suggestedName) {
      const chosen = await requirePicker()(
        [...docs.keys()].map(handleFor),
        "save",
        safeDocumentFilename(suggestedName),
      );
      if (chosen === null) throw new FileStoreError("cancelled", "save cancelled");
      const target = isSavePickerChoice(chosen) ? chosen.handle : chosen;
      const overwrite = isSavePickerChoice(chosen) && chosen.overwrite;
      const key = typeof target === "string" ? safeDocumentFilename(target) : target.key;
      if (docs.has(key) && !overwrite) {
        throw new FileStoreError("already-exists", `${handleFor(key).label} already exists`);
      }
      const modifiedAt = now();
      docs.set(key, { content, modifiedAt });
      return { handle: handleFor(key), modifiedAt };
    },

    async writeRecovery(key, content) {
      const history = recoveries.get(key) ?? [];
      history.push({ id: `rec-${++recoverySeq}`, content, savedAt: now() });
      // Prune from the front: the oldest snapshot is the least useful.
      while (history.length > RECOVERY_HISTORY_LIMIT) history.shift();
      recoveries.set(key, history);

      const all = [...recoveries.entries()]
        .flatMap(([owner, entries]) => entries.map((entry) => ({ owner, entry })))
        .sort((a, b) => a.entry.savedAt - b.entry.savedAt);
      let totalBytes = all.reduce(
        (sum, item) => sum + new TextEncoder().encode(item.entry.content).byteLength,
        0,
      );
      while (all.length > RECOVERY_TOTAL_LIMIT || totalBytes > RECOVERY_TOTAL_BYTES) {
        const oldest = all.shift();
        /* c8 ignore next -- the loop condition proves `all` is non-empty. */
        if (oldest === undefined) break;
        totalBytes -= new TextEncoder().encode(oldest.entry.content).byteLength;
        // `all` is a synchronous projection of `recoveries`, so both lookups are
        // guaranteed until this exact entry is removed.
        const owned = recoveries.get(oldest.owner) as RecoveryEntry[];
        const index = owned.findIndex((entry) => entry.id === oldest.entry.id);
        owned.splice(index, 1);
        if (owned.length === 0) recoveries.delete(oldest.owner);
      }
    },

    async clearRecovery(key) {
      recoveries.delete(key);
    },

    async dropRecovery(id) {
      for (const [key, history] of recoveries) {
        const index = history.findIndex((entry) => entry.id === id);
        if (index === -1) continue;
        history.splice(index, 1);
        // An empty history is indistinguishable from no history; do not keep the
        // key around to be iterated forever.
        if (history.length === 0) recoveries.delete(key);
        return;
      }
    },

    async listRecoveries() {
      const out: RecoveryInfo[] = [];
      let retainedBytes = 0;
      const candidates = [...recoveries.entries()]
        .flatMap(([key, history]) => history.map((blob) => ({ key, blob })))
        .sort((a, b) => b.blob.savedAt - a.blob.savedAt);
      for (const { key, blob } of candidates.slice(0, RECOVERY_TOTAL_LIMIT)) {
        const source = docs.get(key);
        // Offer it when the source is gone (never saved) or the blob is newer.
        if (source !== undefined && source.modifiedAt >= blob.savedAt) continue;
        const bytes = new TextEncoder().encode(blob.content).byteLength;
        if (retainedBytes + bytes > RECOVERY_STARTUP_BYTES) continue;
        retainedBytes += bytes;
        out.push({
          id: blob.id,
          handle: handleFor(key),
          content: blob.content,
          recoveredAt: blob.savedAt,
          sourceModifiedAt: source?.modifiedAt ?? null,
        });
      }
      // Newest first, per the port contract.
      return out.sort((a, b) => b.recoveredAt - a.recoveredAt);
    },

    async listRecent() {
      return [...recent].sort((a, b) => b.openedAt - a.openedAt);
    },

    async pushRecent(handle) {
      const existing = recent.findIndex((r) => r.handle.key === handle.key);
      if (existing !== -1) recent.splice(existing, 1);
      recent.push({ handle: handleFor(handle.key), openedAt: now() });
    },

    snapshot() {
      return Object.fromEntries([...docs].map(([k, v]) => [k, v.content]));
    },

    recoverySnapshot() {
      return Object.fromEntries(
        [...recoveries].map(([k, history]) => [k, history.map((entry) => entry.content)]),
      );
    },
  };
}
