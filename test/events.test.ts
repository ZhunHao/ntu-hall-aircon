import { describe, expect, it } from "vitest";
import { dueEvent, nextEventAfter, sgtWeekMinute, weekEvents } from "../src/shared/events";
import type { Day, Fan, Mode, Period } from "../src/shared/schedule";

const P = (day: Day, start: string, end: string, setpoint = 24, mode: Mode = "C", fan: Fan = "A"): Period => ({
  day,
  start,
  end,
  setpoint,
  mode,
  fan,
});

const MON_0000_SGT = Date.UTC(2026, 10, 1, 16, 0); // Mon 2 Nov 2026 00:00 SGT = Sun 1 Nov 16:00 UTC
const MIN = 60e3;

describe("events in Singapore time", () => {
  it("SGT week minute from a UTC clock", () => {
    expect(sgtWeekMinute(MON_0000_SGT)).toBe(0);
    expect(sgtWeekMinute(MON_0000_SGT + 23 * 3600e3)).toBe(1380);
  });

  it("back-to-back periods give no off between them", () => {
    const ev = weekEvents([P(0, "23:00", "01:00"), P(1, "01:00", "03:00", 25, "D")]);
    expect(ev.map((e) => e.id)).toEqual(["start@1380", "start@1500", "end@1620"]);
  });

  it("period across 11:00 gets a resume at 11:01; ending at 11:00 does not", () => {
    expect(weekEvents([P(4, "01:00", "12:30")]).map((e) => e.id)).toEqual(["start@5820", "resume@6421", "end@6510"]);
    expect(weekEvents([P(4, "01:00", "11:00")]).some((e) => e.kind === "resume")).toBe(false);
  });

  it("next event: 23:00 Monday SGT fires at 15:00 UTC", () => {
    const n = nextEventAfter([P(0, "23:00", "01:00")], MON_0000_SGT + 3600e3);
    expect(new Date(n!.atMs).toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });

  it("Sunday-night period wraps to next week's Monday end", () => {
    const n = nextEventAfter([P(6, "23:00", "01:00")], MON_0000_SGT + 6 * 1440 * 60e3 + 23.5 * 3600e3);
    expect(n!.ev.kind).toBe("end");
  });

  it("due: catches up to the latest event only, skips done and stale", () => {
    const ps = [P(0, "23:00", "01:00"), P(1, "01:00", "03:00", 25, "D")];
    const at0105 = MON_0000_SGT + (1440 + 65) * 60e3;
    expect(dueEvent(ps, at0105, new Set())!.ev.id).toBe("start@1500");
    const d = dueEvent(ps, at0105, new Set())!;
    expect(dueEvent(ps, at0105, new Set([d.key]))).toBeNull();
    expect(dueEvent(ps, MON_0000_SGT + (1440 + 120) * 60e3, new Set())).toBeNull(); // 01:00 start is 60 min stale
  });

  it("no periods: nothing next, nothing due", () => {
    expect(nextEventAfter([], MON_0000_SGT)).toBeNull();
    expect(dueEvent([], MON_0000_SGT, new Set())).toBeNull();
    expect(weekEvents([])).toEqual([]);
  });

  it("due looks back across the week boundary: Sunday 23:55 start seen at Monday 00:05", () => {
    const ps = [P(6, "23:55", "01:00")];
    const now = MON_0000_SGT + 5 * MIN; // Monday 00:05 SGT; the start was last Sunday 23:55, 10 min ago
    const d = dueEvent(ps, now, new Set())!;
    expect(d.ev.id).toBe("start@10075");
    expect(new Date(d.atMs).toISOString()).toBe("2026-11-01T15:55:00.000Z");
    expect(d.key).toBe(`start@10075#${d.atMs}`);
  });

  it("due across the week boundary: Sunday 23:00 start is 65 min old at Monday 00:05, so stale unless allowed", () => {
    const ps = [P(6, "23:00", "01:00")];
    const now = MON_0000_SGT + 5 * MIN;
    expect(dueEvent(ps, now, new Set())).toBeNull();
    const d = dueEvent(ps, now, new Set(), 2 * 3600e3)!;
    expect(d.ev.id).toBe("start@10020");
    expect(new Date(d.atMs).toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });

  it("an event exactly now is due but not next", () => {
    const ps = [P(0, "23:00", "01:00")];
    const at = MON_0000_SGT + 1380 * MIN;
    expect(dueEvent(ps, at, new Set())!.ev.id).toBe("start@1380");
    expect(nextEventAfter(ps, at)!.ev.id).toBe("end@1500");
  });

  it("the same event a week later has a different key", () => {
    const ps = [P(0, "23:00", "01:00")];
    const d1 = dueEvent(ps, MON_0000_SGT + 1385 * MIN, new Set())!;
    const d2 = dueEvent(ps, MON_0000_SGT + (1385 + 10080) * MIN, new Set([d1.key]))!;
    expect(d2.key).not.toBe(d1.key);
    expect(d2.ev.id).toBe(d1.ev.id);
  });

  it("an older unexecuted event is not replayed when the latest is already done", () => {
    const ps = [P(0, "10:00", "10:10"), P(0, "10:20", "10:30")];
    const now = MON_0000_SGT + (10 * 60 + 25) * MIN; // latest is start 10:20; end 10:10 is only 15 min old
    const d = dueEvent(ps, now, new Set())!;
    expect(d.ev.id).toBe("start@620");
    expect(dueEvent(ps, now, new Set([d.key]))).toBeNull();
  });

  it("staleMs is tunable", () => {
    const ps = [P(0, "23:00", "01:00")];
    const now = MON_0000_SGT + (1380 + 45) * MIN;
    expect(dueEvent(ps, now, new Set())).toBeNull();
    expect(dueEvent(ps, now, new Set(), 60 * MIN)!.ev.id).toBe("start@1380");
  });
});
