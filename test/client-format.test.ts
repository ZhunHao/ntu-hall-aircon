import { describe, expect, it } from "vitest";
import { dateSgt, dateTimeSgt, fanFromUi, fanLabel, safeHttpsUrl, safeQr, sgd } from "../src/client/lib/format";

describe("sgd", () => {
  it("formats dollars with two decimals", () => {
    expect(sgd(12.4)).toBe("S$12.40");
    expect(sgd(0)).toBe("S$0.00");
    expect(sgd(1234.5)).toBe("S$1234.50");
  });
  it("puts the sign before the currency", () => {
    expect(sgd(-1.2)).toBe("-S$1.20");
    expect(sgd(-0.001)).toBe("S$0.00");
  });
});

describe("fan helpers", () => {
  it("maps the UI buttons to Daikin fan steps", () => {
    expect(fanFromUi("A")).toBe("A");
    expect(fanFromUi("1")).toBe("L");
    expect(fanFromUi("2")).toBe("LM");
    expect(fanFromUi("3")).toBe("M");
    expect(fanFromUi("4")).toBe("MH");
    expect(fanFromUi("5")).toBe("H");
  });
  it("labels fan steps for display", () => {
    expect(fanLabel("A")).toBe("Auto");
    expect(fanLabel("L")).toBe("1");
    expect(fanLabel("LM")).toBe("2");
    expect(fanLabel("M")).toBe("3");
    expect(fanLabel("MH")).toBe("4");
    expect(fanLabel("H")).toBe("5");
  });
});

describe("dateSgt", () => {
  it("shows the Singapore calendar day", () => {
    // 2027-01-27 17:00 UTC is already 28 Jan in Singapore.
    expect(dateSgt(Date.UTC(2027, 0, 27, 17, 0))).toBe("28 Jan 2027");
    expect(dateSgt(Date.UTC(2027, 0, 27, 15, 59))).toBe("27 Jan 2027");
  });
});

describe("dateTimeSgt", () => {
  it("shows Singapore wall-clock time, not the browser's", () => {
    // 2026-10-30 15:00 UTC is 23:00 in Singapore.
    expect(dateTimeSgt(Date.UTC(2026, 9, 30, 15, 0))).toBe("30 Oct 2026, 23:00");
    // 17:30 UTC on the 30th is already 01:30 on the 31st in Singapore.
    expect(dateTimeSgt(Date.UTC(2026, 9, 30, 17, 30))).toBe("31 Oct 2026, 01:30");
  });
  it("pads hours and minutes", () => {
    expect(dateTimeSgt(Date.UTC(2026, 0, 1, 0, 5))).toBe("1 Jan 2026, 08:05");
  });
});

describe("safeQr", () => {
  it("accepts a base64 PNG data URL", () => {
    const ok = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg+/==";
    expect(safeQr(ok)).toBe(ok);
  });
  it("rejects anything else", () => {
    expect(safeQr("javascript:alert(1)")).toBeNull();
    expect(safeQr("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeQr("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(safeQr("data:image/png;base64,AAAA\"onerror=\"x")).toBeNull();
    expect(safeQr("data:image/png;base64,AAAA\n")).toBeNull();
    expect(safeQr("data:image/png;base64,")).toBeNull();
    expect(safeQr("https://example.com/qr.png")).toBeNull();
    expect(safeQr("")).toBeNull();
    expect(safeQr(undefined)).toBeNull();
    expect(safeQr(null)).toBeNull();
    expect(safeQr(42)).toBeNull();
    expect(safeQr({})).toBeNull();
  });
});

describe("safeHttpsUrl", () => {
  it("returns the normalised href for https URLs", () => {
    expect(safeHttpsUrl("https://pay.example.com/x?a=1")).toBe("https://pay.example.com/x?a=1");
    expect(safeHttpsUrl("HTTPS://Pay.Example.com")).toBe("https://pay.example.com/");
  });
  it("rejects other schemes, malformed and non-string input", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHttpsUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpsUrl("http://pay.example.com")).toBeNull();
    expect(safeHttpsUrl("//pay.example.com")).toBeNull();
    expect(safeHttpsUrl("/relative")).toBeNull();
    expect(safeHttpsUrl("not a url")).toBeNull();
    expect(safeHttpsUrl("")).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl(123)).toBeNull();
    expect(safeHttpsUrl({ href: "https://x.com" })).toBeNull();
  });
});
