import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "../../../tokens/ha-webawesome.css";
import "../styles/app.css";

const KEY = "scheme";

function stored(): "light" | "dark" | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private window or blocked storage
  }
}

/** Light or dark: the saved choice, else the device setting. */
export function currentScheme(): "light" | "dark" {
  return stored() ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

/** Sets the theme classes on <html>. Web Awesome reads `wa-dark`; the Home Assistant layer reads `data-scheme`. */
export function applyScheme(scheme: "light" | "dark"): void {
  const html = document.documentElement;
  html.classList.add("theme-ha", "wa-theme-default", "wa-palette-default");
  html.classList.toggle("wa-dark", scheme === "dark");
  html.classList.toggle("wa-light", scheme === "light");
  html.dataset.scheme = scheme;
}

/** Flips light/dark and remembers it on this device. */
export function toggleScheme(): "light" | "dark" {
  const next = document.documentElement.dataset.scheme === "dark" ? "light" : "dark";
  applyScheme(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not remembered; the page still switched
  }
  return next;
}

applyScheme(currentScheme());
