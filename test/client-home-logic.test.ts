import { describe, expect, it } from "vitest";
import type { AirconView } from "../src/shared/api";
import type { Schedule } from "../src/shared/schedule";
import {
  actionText,
  balancePercent,
  clampSetpoint,
  countdownText,
  dialPoint,
  disabledNote,
  fanUiValue,
  isLowBalance,
  matchesPending,
  mergePending,
  nextEventText,
  overlay,
  roomTempText,
  secondsLeft,
  sgtStamp,
  tempAtPoint,
  unitState,
} from "../src/client/lib/home-logic";

const unit = (over: Partial<AirconView> = {}): AirconView => ({
  power: 1,
  setpoint: 24,
  mode: "C",
  fanstep: "A",
  flap: "N",
  comm_stat: 1,
  maintenance_mode: 0,
  aircon_code: "H11-12-34-5678-01",
  current_temperature: 26,
  room: { room_name: "Room" },
  default_account: true,
  ...over,
});

describe("matchesPending", () => {
  it("is true only when every sent field matches", () => {
    expect(matchesPending(unit({ setpoint: 23 }), { setpoint: 23 })).toBe(true);
    expect(matchesPending(unit({ setpoint: 24 }), { setpoint: 23 })).toBe(false);
    expect(matchesPending(unit({ power: 0, mode: "F" }), { power: 0, mode: "F" })).toBe(true);
    expect(matchesPending(unit({ power: 0, mode: "C" }), { power: 0, mode: "F" })).toBe(false);
  });
  it("ignores fields that were not sent, and an empty change matches", () => {
    expect(matchesPending(unit({ fanstep: "H" }), { setpoint: 24 })).toBe(true);
    expect(matchesPending(unit(), {})).toBe(true);
  });
  it("checks fan and flap", () => {
    expect(matchesPending(unit({ fanstep: "MH" }), { fanstep: "MH" })).toBe(true);
    expect(matchesPending(unit({ flap: "N" }), { flap: "S" })).toBe(false);
  });
});

describe("pending changes", () => {
  it("merge field by field with the newer winning", () => {
    expect(mergePending({ setpoint: 23, power: 1 }, { setpoint: 25 })).toEqual({ setpoint: 25, power: 1 });
  });
  it("overlay the sent fields on the unit", () => {
    const v = overlay(unit({ setpoint: 24, mode: "C" }), { setpoint: 22 });
    expect(v.setpoint).toBe(22);
    expect(v.mode).toBe("C");
  });
});

describe("unitState", () => {
  it("covers unpaired, offline, maintenance and online", () => {
    expect(unitState(null)).toBe("unpaired");
    expect(unitState(unit({ comm_stat: 0 }))).toBe("offline");
    expect(unitState(unit({ comm_stat: 2 }))).toBe("offline");
    expect(unitState(unit({ maintenance_mode: 1 }))).toBe("maintenance");
    expect(unitState(unit())).toBe("online");
  });
  it("reports offline before maintenance", () => {
    expect(unitState(unit({ comm_stat: 0, maintenance_mode: 1 }))).toBe("offline");
  });
});

describe("balance", () => {
  it("is low below S$3", () => {
    expect(isLowBalance(2.99)).toBe(true);
    expect(isLowBalance(3)).toBe(false);
    expect(isLowBalance(0)).toBe(true);
  });
  it("fills a bar out of S$50", () => {
    expect(balancePercent(25)).toBe(50);
    expect(balancePercent(80)).toBe(100);
    expect(balancePercent(-1)).toBe(0);
  });
});

describe("dial text", () => {
  it("says what the unit is doing", () => {
    expect(actionText("online", 1, "C", false)).toBe("Cooling");
    expect(actionText("online", 1, "D", false)).toBe("Dehumidifying");
    expect(actionText("online", 0, "C", false)).toBe("Off");
    expect(actionText("online", 1, "C", true)).toBe("Sending…");
    expect(actionText("offline", 1, "C", true)).toBe("Unavailable");
    expect(actionText("maintenance", 1, "C", false)).toBe("Maintenance");
  });
  it("explains disabled controls", () => {
    expect(disabledNote("online")).toBe("");
    expect(disabledNote("offline")).toMatch(/reconnects/);
    expect(disabledNote("maintenance")).toMatch(/paused/);
  });
});

describe("roomTempText", () => {
  it("shows one decimal, or a dash when the unit sends no reading", () => {
    expect(roomTempText(unit({ current_temperature: 26 }))).toBe("26.0 °C");
    expect(roomTempText(unit({ current_temperature: 25.46 }))).toBe("25.5 °C");
    expect(roomTempText(unit({ current_temperature: null }))).toBe("—");
    expect(roomTempText(null)).toBe("—");
  });
});

describe("countdown", () => {
  it("formats minutes and seconds", () => {
    expect(countdownText(900)).toBe("15:00");
    expect(countdownText(65)).toBe("01:05");
    expect(countdownText(-4)).toBe("00:00");
  });
  it("counts whole seconds to a deadline", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_001, 0)).toBe(11);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
  });
});

describe("nextEventText", () => {
  // Monday 2027-02-01 00:00 SGT is Sunday 16:00 UTC.
  const mondayMidnight = Date.UTC(2027, 0, 31, 16, 0);
  const sched = (over: Partial<Schedule> = {}): Schedule => ({
    enabled: true,
    view: "nights",
    periods: [{ day: 0, start: "23:00", end: "07:00", setpoint: 23, mode: "C", fan: "A" }],
    ...over,
  });
  it("names the next start with the shared summary", () => {
    expect(nextEventText(sched(), mondayMidnight)).toBe("Next: Mon 23:00 · On 23 °C Cool, fan auto");
  });
  it("names an end as Off", () => {
    // Tuesday 00:30 SGT, inside the Monday night period.
    expect(nextEventText(sched(), mondayMidnight + 24.5 * 3_600_000)).toBe("Next: Tue 07:00 · Off");
  });
  it("handles a switched off or empty schedule", () => {
    expect(nextEventText(null, 0)).toBe("Schedule is off");
    expect(nextEventText(sched({ enabled: false }), 0)).toBe("Schedule is off");
    expect(nextEventText(sched({ periods: [] }), 0)).toBe("No schedule yet");
  });
  it("shows Singapore time, not UTC", () => {
    expect(sgtStamp(Date.UTC(2027, 0, 31, 15, 0))).toBe("Sun 23:00");
  });
});

describe("dial geometry", () => {
  it("places the minimum at the lower left and the maximum at the lower right", () => {
    const lo = dialPoint(22, 22, 26);
    const hi = dialPoint(26, 22, 26);
    expect(lo.f).toBe(0);
    expect(hi.f).toBe(1);
    expect(lo.x).toBeLessThan(130);
    expect(hi.x).toBeGreaterThan(130);
    expect(lo.y).toBeGreaterThan(130);
  });
  it("puts the middle at the top", () => {
    const mid = dialPoint(24, 22, 26);
    expect(mid.x).toBeCloseTo(130, 5);
    expect(mid.y).toBeCloseTo(22, 5);
  });
  it("clamps out-of-range temperatures", () => {
    expect(dialPoint(40, 22, 26).f).toBe(1);
    expect(dialPoint(0, 22, 26).f).toBe(0);
  });
  it("reads a temperature back from a point", () => {
    for (const t of [22, 23, 24, 25, 26]) {
      const p = dialPoint(t, 22, 26);
      expect(tempAtPoint(p.x, p.y, 22, 26)).toBeCloseTo(t, 5);
    }
  });
  it("snaps the gap at the bottom to the nearer end", () => {
    expect(tempAtPoint(100, 250, 22, 26)).toBe(22); // bottom, left of centre
    expect(tempAtPoint(160, 250, 22, 26)).toBe(26); // bottom, right of centre
  });
  it("rounds and clamps a setpoint", () => {
    expect(clampSetpoint(23.4, 22, 26)).toBe(23);
    expect(clampSetpoint(23.6, 22, 26)).toBe(24);
    expect(clampSetpoint(30, 22, 26)).toBe(26);
    expect(clampSetpoint(10, 22, 26)).toBe(22);
  });
});

describe("fanUiValue", () => {
  it("gives the button value for each fan step", () => {
    expect((["A", "L", "LM", "M", "MH", "H"] as const).map(fanUiValue)).toEqual(["A", "1", "2", "3", "4", "5"]);
  });
});
