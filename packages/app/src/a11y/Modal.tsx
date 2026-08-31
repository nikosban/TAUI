import { useEffect, useId, useRef } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface ModalProps {
  readonly title: string;
  readonly onDismiss: () => void;
  readonly children: React.ReactNode;
}

/**
 * Shared modal mechanics: named dialog semantics, initial focus, a Tab loop,
 * Escape dismissal, and focus restoration. The App makes its sibling surface
 * inert while any Modal is mounted.
 */
export function Modal({ title, onDismiss, children }: ModalProps): React.JSX.Element {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const parent = backdrop?.parentElement;
    const managed = new Map<HTMLElement, boolean>();
    const makeSiblingsInert = (): void => {
      for (const element of parent?.children ?? []) {
        if (!(element instanceof HTMLElement) || element === backdrop || managed.has(element)) {
          continue;
        }
        managed.set(element, element.inert);
        element.inert = true;
      }
    };
    makeSiblingsInert();
    const observer = new MutationObserver(makeSiblingsInert);
    if (parent !== null && parent !== undefined) observer.observe(parent, { childList: true });

    const dialog = dialogRef.current;
    const initial =
      dialog?.querySelector<HTMLElement>("[data-initial-focus]") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE) ??
      dialog;
    initial?.focus();

    return () => {
      observer.disconnect();
      for (const [sibling, wasInert] of managed) sibling.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div ref={backdropRef} className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          if (event.key !== "Tab") return;

          const focusable = [
            ...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
          ];
          if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
