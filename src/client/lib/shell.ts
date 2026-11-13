import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/page/page.js";
import type WaPage from "@awesome.me/webawesome/dist/components/page/page.js";
import type { SessionInfo } from "../../shared/api";
import { api } from "./api";
import { dateSgt } from "./format";
import { icon, type IconKey } from "./icons";
import { shellAction, watchPageShow } from "./session-logic";
import { toggleScheme } from "./theme";

export type NavId = "home" | "schedule" | "history" | "settings";

const NAV: { id: NavId; label: string; href: string; icon: IconKey }[] = [
  { id: "home", label: "Home", href: "/", icon: "home" },
  { id: "schedule", label: "Schedule", href: "/schedule", icon: "schedule" },
  { id: "history", label: "History", href: "/history", icon: "chart" },
  { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(id: string, title: string, key: IconKey, cls?: string): HTMLElement {
  const b = el("wa-button", cls);
  b.id = id;
  b.setAttribute("appearance", "plain");
  b.setAttribute("size", "s");
  b.setAttribute("title", title);
  b.append(icon(key, title));
  return b;
}

/**
 * Fills `banner` when the login ends within 7 days, or sends a login Daikin has ended to the sign-in page.
 * No-op when signed out or the call fails.
 */
async function showExpiryBanner(banner: HTMLElement): Promise<void> {
  let info: SessionInfo;
  try {
    info = await api<SessionInfo>("GET", "/api/session");
  } catch {
    return;
  }
  const action = shellAction(info, Date.now(), location.pathname);
  if (action.kind === "expired") {
    location.assign("/signin#expired");
    return;
  }
  if (action.kind !== "banner") return;
  const link = el("a", undefined, `Sign in again by ${dateSgt(action.expiresMs)}`);
  // #renew keeps the sign-in page from sending a still-valid session straight back home.
  link.href = "/signin#renew";
  banner.replaceChildren(link);
}

/**
 * Replaces the page body with the app shell (header, navigation, expiry banner, light/dark toggle)
 * and returns the element the page fills with its content.
 */
export function mountShell(active: NavId): HTMLElement {
  watchPageShow(window, location);
  const page = el("wa-page") as WaPage;
  page.setAttribute("mobile-breakpoint", "870");
  // The menu button below replaces wa-page's own toggle.
  page.setAttribute("disable-navigation-toggle", "");

  const banner = el("div", "expiry-banner");
  banner.slot = "banner";

  const header = el("header", "shell-header");
  header.slot = "header";
  const left = el("span", "left");
  const menu = iconButton("menu", "Menu", "menu", "menu-btn");
  menu.addEventListener("click", () => page.toggleNavigation());
  const brand = el("span", "brand");
  brand.append(icon("ac"), "Hall Aircon");
  left.append(menu, brand);
  const scheme = iconButton("scheme", "Light or dark", "dark");
  scheme.addEventListener("click", () => toggleScheme());
  header.append(left, scheme);

  const nav = el("nav", "nav");
  nav.slot = "navigation";
  nav.setAttribute("aria-label", "Main");
  for (const item of NAV) {
    const a = el("a");
    a.href = item.href;
    if (item.id === active) a.setAttribute("aria-current", "page");
    a.append(icon(item.icon), item.label);
    nav.append(a);
  }

  const main = el("main", "content");
  main.id = "content";

  page.append(header, nav, main);
  document.body.replaceChildren(page);
  // The banner slot stays out of the page until it has something to say (wa-page hides an empty banner).
  void showExpiryBanner(banner).then(() => {
    if (banner.firstChild) page.prepend(banner);
  });
  return main;
}
