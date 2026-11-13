import { describe, expect, it } from "vitest";
import {
  cuts,
  dur,
  groupOf,
  overlaps,
  samePeriod,
  span,
  validate,
  weeklyCost,
  type Day,
  type Fan,
  type Mode,
  type Period,
  type Schedule,
} from "../src/shared/schedule";

const P = (day: Day, start: string, end: string, setpoint = 24, mode: Mode = "C", fan: Fan = "A"): Period => ({
  day,
  start,
  end,
  setpoint,
  mode,
  fan,
});

describe("schedule maths", () => {
  it("span crosses midnight", () => expect(span(P(0, "23:00", "01:00"))).toEqual({ s: 1380, e: 1500 }));

  it("Sunday night wraps into Monday", () =>
    expect(overlaps(span(P(6, "23:00", "02:00")), span(P(0, "01:00", "03:00")))).toBe(true));

  it("back-to-back is not an overlap", () =>
    expect(overlaps(span(P(0, "23:00", "01:00")), span(P(1, "01:00", "03:00")))).toBe(false));

  it("01:00 Tuesday belongs to Monday night, Tuesday day", () => {
    expect(groupOf(P(1, "01:00", "03:00"), "nights")).toBe(0);
    expect(groupOf(P(1, "01:00", "03:00"), "days")).toBe(1);
  });

  it("cuts lists 11:00 strictly inside", () => {
    expect(cuts(span(P(4, "01:00", "12:30")))).toEqual([4 * 1440 + 660]);
    expect(cuts(span(P(4, "01:00", "11:00")))).toEqual([]);
  });

  it("dur is 1..1439, end before start crosses midnight", () => {
    expect(dur(P(0, "23:00", "01:00"))).toBe(120);
    expect(dur(P(0, "01:00", "12:30"))).toBe(690);
    expect(dur(P(0, "00:00", "23:59"))).toBe(1439);
    expect(dur(P(0, "00:01", "00:00"))).toBe(1439);
    expect(dur(P(0, "00:00", "00:01"))).toBe(1);
  });

  it("samePeriod ignores the day", () => {
    expect(samePeriod(P(0, "23:00", "01:00"), P(3, "23:00", "01:00"))).toBe(true);
    expect(samePeriod(P(0, "23:00", "01:00"), P(0, "23:00", "01:00", 25))).toBe(false);
    expect(samePeriod(P(0, "23:00", "01:00"), P(0, "23:00", "01:00", 24, "D"))).toBe(false);
    expect(samePeriod(P(0, "23:00", "01:00"), P(0, "23:00", "01:00", 24, "C", "H"))).toBe(false);
    expect(samePeriod(P(0, "23:00", "01:00"), P(0, "23:00", "01:30"))).toBe(false);
  });

  it("validate flags start at 11:00, zero length, bad setpoint, overlap", () => {
    const s: Schedule = {
      enabled: true,
      view: "nights",
      periods: [
        P(0, "11:00", "12:00"),
        P(1, "02:00", "02:00"),
        P(2, "23:00", "01:00", 27),
        P(3, "23:00", "02:00"),
        P(4, "01:00", "03:00"),
      ],
    };
    expect(validate(s).map((p) => p.code)).toEqual(["start-1100", "zero-length", "setpoint", "overlap"]);
    expect(validate(s).at(-1)).toEqual({ code: "overlap", index: 4, other: 3 });
  });

  it("validate flags unknown mode, fan and malformed times, in period order", () => {
    const bad = (day: Day, over: Partial<Record<keyof Period, unknown>>) => ({ ...P(day, "01:00", "02:00"), ...over }) as Period;
    const s: Schedule = {
      enabled: true,
      view: "days",
      periods: [
        bad(0, { mode: "X" }),
        bad(1, { fan: "Q" }),
        bad(2, { start: "25:00" }),
        bad(3, { end: "9:5" }),
        bad(4, { setpoint: 23.5 }),
      ],
    };
    expect(validate(s)).toEqual([
      { code: "mode", index: 0 },
      { code: "fan", index: 1 },
      { code: "time", index: 2 },
      { code: "time", index: 3 },
      { code: "setpoint", index: 4 },
    ]);
  });

  it("zero-length and malformed periods produce no overlap problems", () => {
    const s: Schedule = {
      enabled: true,
      view: "nights",
      periods: [P(0, "01:00", "05:00"), P(0, "02:00", "02:00"), { ...P(0, "03:00", "04:00"), end: "bad" }],
    };
    expect(validate(s)).toEqual([
      { code: "zero-length", index: 1 },
      { code: "time", index: 2 },
    ]);
  });

  it("validate flags a day that is not an integer 0..6 and skips overlap checks for it", () => {
    for (const day of [7, -1, 1.5, NaN, "x", undefined]) {
      const s: Schedule = {
        enabled: true,
        view: "nights",
        periods: [P(0, "01:00", "05:00"), { ...P(0, "02:00", "04:00"), day } as unknown as Period],
      };
      expect(validate(s), String(day)).toEqual([{ code: "day", index: 1 }]);
    }
  });

  it("validate returns nothing for a clean schedule", () => {
    const s: Schedule = { enabled: true, view: "nights", periods: [P(0, "23:00", "01:00"), P(0, "01:00", "03:00")] };
    expect(validate(s)).toEqual([]);
  });

  it("weekly cost subtracts a minute per cut-off", () => {
    expect(weeklyCost([P(4, "01:00", "12:30")])).toEqual({ minutes: 689, sgd: 4.48 });
    expect(weeklyCost([])).toEqual({ minutes: 0, sgd: 0 });
  });
});
