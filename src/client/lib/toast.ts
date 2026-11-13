export type ToastVariant = "success" | "danger" | "warning" | "neutral";

/** A button inside the toast, e.g. "Apply now". Clicking it runs `run` and closes the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

let host: HTMLElement | null = null;

/**
 * A short message at the bottom of the screen. Built from plain elements and classes: Web Awesome's
 * <wa-toast> sets inline styles, which the CSP (style-src 'self') blocks and reports as console errors.
 */
export function toast(message: string, variant: ToastVariant = "neutral", durationMs = 3500, action?: ToastAction): void {
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const item = document.createElement("div");
  item.className = `toast toast-${variant}`;
  const text = document.createElement("span");
  text.textContent = message;
  item.append(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      item.remove();
      action.run();
    });
    item.classList.add("has-action");
    item.append(btn);
  }
  host.append(item);
  setTimeout(() => item.remove(), durationMs);
}
