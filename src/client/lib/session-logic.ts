import type { SessionInfo } from "../../shared/api";

const DAY = 86_400_000;
/** The "sign in again" banner shows this long before the Daikin login expires. */
export const WARN_MS = 7 * DAY;

const SIGNIN_PATHS = new Set(["/signin", "/signin.html"]);

/** Which screen the sign-in page opens on. `info` is null when the session wasn't (or couldn't be) read. */
export type SigninStart = "expired" | "steps" | "home" | "welcome";

/**
 * `#expired` and `#renew` open their screens whatever the session says: `#renew` is the banner's link,
 * shown only while the session is valid, so it must not bounce back home.
 */
export function signinStart(hash: string, info: SessionInfo | null): SigninStart {
  if (hash === "#expired") return "expired";
  if (hash === "#renew") return "steps";
  return info?.valid ? "home" : "welcome";
}

/** What the app shell does with `/api/session`. */
export type ShellAction = { kind: "none" } | { kind: "expired" } | { kind: "banner"; expiresMs: number };

export function shellAction(info: SessionInfo, nowMs: number, pathname: string): ShellAction {
  if (!info.valid || SIGNIN_PATHS.has(pathname)) return { kind: "none" };
  if (info.expired) return { kind: "expired" };
  if (typeof info.expiresMs === "number" && info.expiresMs - nowMs <= WARN_MS) {
    return { kind: "banner", expiresMs: info.expiresMs };
  }
  return { kind: "none" };
}

/**
 * A page restored from the back/forward cache shows its old content without asking the server,
 * so after sign-out Back could re-show the owner's data. Reloading makes the API answer (401 sends the browser to /signin).
 */
export function onPageShow(e: { persisted: boolean }, loc: { reload(): void }): void {
  if (e.persisted) loc.reload();
}

/** Registers `onPageShow` on the window. */
export function watchPageShow(
  win: { addEventListener(type: "pageshow", fn: (e: { persisted: boolean }) => void): void },
  loc: { reload(): void },
): void {
  win.addEventListener("pageshow", (e) => onPageShow(e, loc));
}
