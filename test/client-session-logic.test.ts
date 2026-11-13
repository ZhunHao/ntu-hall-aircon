import { describe, expect, it } from "vitest";
import { onPageShow, shellAction, signinStart, watchPageShow } from "../src/client/lib/session-logic";

const DAY = 86_400_000;
const NOW = Date.parse("2040-01-02T04:00:00Z");

describe("signinStart", () => {
  it("shows the sign-in steps for #renew, even with a valid session", () => {
    expect(signinStart("#renew", null)).toBe("steps");
    expect(signinStart("#renew", { valid: true, expiresMs: NOW + DAY })).toBe("steps");
  });

  it("shows the expired screen for #expired", () => {
    expect(signinStart("#expired", null)).toBe("expired");
    expect(signinStart("#expired", { valid: true })).toBe("expired");
  });

  it("goes home with a valid session and no hash", () => {
    expect(signinStart("", { valid: true })).toBe("home");
  });

  it("shows the welcome screen when signed out or unreachable", () => {
    expect(signinStart("", { valid: false })).toBe("welcome");
    expect(signinStart("", null)).toBe("welcome");
    expect(signinStart("#other", null)).toBe("welcome");
  });
});

describe("shellAction", () => {
  it("does nothing when signed out", () => {
    expect(shellAction({ valid: false }, NOW, "/schedule")).toEqual({ kind: "none" });
  });

  it("sends a Daikin-expired login to /signin#expired", () => {
    expect(shellAction({ valid: true, expired: true, expiresMs: NOW + 30 * DAY }, NOW, "/schedule")).toEqual({
      kind: "expired",
    });
  });

  it("never redirects from the sign-in page itself", () => {
    expect(shellAction({ valid: true, expired: true }, NOW, "/signin")).toEqual({ kind: "none" });
    expect(shellAction({ valid: true, expired: true }, NOW, "/signin.html")).toEqual({ kind: "none" });
  });

  it("shows the renew banner within 7 days of expiry", () => {
    expect(shellAction({ valid: true, expired: false, expiresMs: NOW + 7 * DAY }, NOW, "/")).toEqual({
      kind: "banner",
      expiresMs: NOW + 7 * DAY,
    });
  });

  it("shows nothing further out, or without an expiry", () => {
    expect(shellAction({ valid: true, expired: false, expiresMs: NOW + 7 * DAY + 1 }, NOW, "/")).toEqual({ kind: "none" });
    expect(shellAction({ valid: true, expired: false }, NOW, "/")).toEqual({ kind: "none" });
  });
});

describe("onPageShow", () => {
  it("reloads when the page was restored from the back/forward cache", () => {
    let reloads = 0;
    onPageShow({ persisted: true }, { reload: () => void reloads++ });
    expect(reloads).toBe(1);
  });

  it("does nothing on a normal load", () => {
    let reloads = 0;
    onPageShow({ persisted: false }, { reload: () => void reloads++ });
    expect(reloads).toBe(0);
  });
});

describe("watchPageShow", () => {
  it("registers a pageshow handler that reloads only when persisted", () => {
    const handlers: Record<string, (e: { persisted: boolean }) => void> = {};
    let reloads = 0;
    watchPageShow(
      { addEventListener: (type, fn) => void (handlers[type] = fn) },
      { reload: () => void reloads++ },
    );
    expect(Object.keys(handlers)).toEqual(["pageshow"]);
    handlers.pageshow({ persisted: false });
    expect(reloads).toBe(0);
    handlers.pageshow({ persisted: true });
    expect(reloads).toBe(1);
  });
});
