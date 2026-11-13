import { describe, expect, it } from "vitest";
import {
  afterPage,
  notificationText,
  PAGE_SIZE,
  parseDaikinTime,
  startPaging,
  topUpText,
  usageText,
  whenText,
} from "../src/client/lib/history-logic";

describe("paging", () => {
  it("starts at offset 0, not done", () => {
    expect(startPaging()).toEqual({ offset: 0, done: false });
  });

  it("asks for 20 rows at a time", () => {
    expect(PAGE_SIZE).toBe(20);
  });

  it("moves the offset by the rows received and keeps Load more after a full page", () => {
    expect(afterPage(startPaging(), 20)).toEqual({ offset: 20, done: false });
    expect(afterPage({ offset: 20, done: false }, 20)).toEqual({ offset: 40, done: false });
  });

  it("hides Load more when a page has fewer than 20 rows", () => {
    expect(afterPage({ offset: 40, done: false }, 7)).toEqual({ offset: 47, done: true });
    expect(afterPage(startPaging(), 0)).toEqual({ offset: 0, done: true });
  });

  it("hides Load more once the usage total is reached, even on a full page", () => {
    expect(afterPage({ offset: 20, done: false }, 20, 40)).toEqual({ offset: 40, done: true });
    expect(afterPage(startPaging(), 20, 45)).toEqual({ offset: 20, done: false });
  });
});

describe("parseDaikinTime", () => {
  it("reads an ISO time with an offset", () => {
    expect(parseDaikinTime("2026-10-19T04:15:01.000+08:00")).toBe(Date.UTC(2026, 9, 18, 20, 15, 1));
  });
  it("treats a time without an offset as Singapore time, never the browser's", () => {
    expect(parseDaikinTime("2026-10-19T04:15:01")).toBe(Date.UTC(2026, 9, 18, 20, 15, 1));
    expect(parseDaikinTime("2026-10-19 04:15:01")).toBe(Date.UTC(2026, 9, 18, 20, 15, 1));
  });
  it("returns null for junk", () => {
    expect(parseDaikinTime("")).toBeNull();
    expect(parseDaikinTime("soon")).toBeNull();
  });
});

describe("whenText", () => {
  it("formats in Singapore time", () => {
    expect(whenText("2026-10-30T23:00:00.000+08:00")).toBe("30 Oct 2026, 23:00");
    expect(whenText("2026-10-30T15:00:00.000Z")).toBe("30 Oct 2026, 23:00");
  });
  it("shows a dash when the time is missing or unreadable", () => {
    expect(whenText("")).toBe("—");
    expect(whenText("nope")).toBe("—");
  });
});

describe("row text", () => {
  it("usage: start, end, minutes, S$", () => {
    expect(
      usageText({
        starttime: "2026-10-30T23:00:00.000+08:00",
        endtime: "2026-10-31T07:00:00.000+08:00",
        duration: 480,
        amount: 3.12,
      }),
    ).toEqual({
      start: "30 Oct 2026, 23:00",
      end: "Ended 31 Oct 2026, 07:00",
      minutes: "480 min",
      amount: "S$3.12",
    });
  });

  it("usage: a session with no end time is still running", () => {
    expect(usageText({ starttime: "2026-10-30T23:00:00.000+08:00", endtime: null, duration: 12, amount: 0.08 }).end).toBe(
      "Still running",
    );
  });

  it("top-ups: date, type, amount, status", () => {
    expect(topUpText({ type: "PayNow", created_on: "2026-10-28T22:25:29.000+08:00", amount: 10, status: 1 })).toEqual({
      date: "28 Oct 2026, 22:25",
      type: "PayNow",
      amount: "S$10.00",
      status: "Paid",
    });
    expect(topUpText({ type: "VisaMaster", created_on: "", amount: 20, status: 0 }).status).toBe("Not paid");
  });

  it("notifications: title, message, date", () => {
    expect(
      notificationText({ title: "Low Balance", message: "Top up.", send_on: "2026-10-29T08:00:00.000+08:00", status: true }),
    ).toEqual({ title: "Low Balance", message: "Top up.", date: "29 Oct 2026, 08:00" });
  });
});
