import { describe, expect, it } from "vitest";
import type { Activity } from "../src/shared/api";
import type { Day, Period, Schedule } from "../src/shared/schedule";
import {
  activityLine,
  activityTime,
  bars,
  carryOver,
  carryText,
  costText,
  CUT_NOTE,
  cutMark,
  dayFor,
  defaultDraft,
  draftCrossesCut,
  editBlock,
  type Draft,
  group,
  linkedTo,
  offersApplyNow,
  periodAt,
  periodTag,
  periodWhat,
  planCopy,
  planDelete,
  planEdit,
  problemText,
  repeatWindows,
  repeatsText,
  runsText,
  statusText,
  tabLabel,
  tabSummary,
  windowAt,
  windowSub,
  windowTitle,
} from "../src/client/lib/schedule-logic";

const P = (day: number, start: string, end: string, setpoint = 24, mode: Period["mode"] = "C", fan: Period["fan"] = "A"): Period => ({
  day: day as Day,
  start,
  end,
  setpoint,
  mode,
  fan,
});
const draft = (start: string, end: string, over: Partial<Draft> = {}): Draft => ({ start, end, setpoint: 24, mode: "C", fan: "A", ...over });
const sched = (periods: Period[], over: Partial<Schedule> = {}): Schedule => ({ periods, enabled: true, view: "nights", ...over });

// Monday 2 Nov 2026 00:00 SGT = Sunday 1 Nov 16:00 UTC.
const MON = Date.UTC(2026, 10, 1, 16, 0);
const at = (day: number, hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return MON + (day * 1440 + h * 60 + m) * 60_000;
};

describe("titles", () => {
  it("names nights and days", () => {
    expect(windowTitle("nights", 4)).toBe("Friday night");
    expect(windowSub("nights", 6)).toBe("Sun 12:00 → Mon 12:00");
    expect(windowTitle("days", 4)).toBe("Friday");
    expect(windowSub("days", 4)).toBe("Fri 00:00 → 24:00");
  });
});

describe("group", () => {
  it("puts an after-midnight period on the night before, sorted from noon", () => {
    const ps = [P(1, "01:00", "03:00"), P(0, "23:00", "01:00"), P(0, "13:00", "14:00")];
    expect(group(ps, 0, "nights").map((p) => p.start)).toEqual(["13:00", "23:00", "01:00"]);
    expect(group(ps, 1, "nights")).toEqual([]);
    expect(group(ps, 1, "days").map((p) => p.start)).toEqual(["01:00"]);
  });
  it("puts Monday 01:00 on Sunday night", () => {
    expect(group([P(0, "01:00", "03:00")], 6, "nights")).toHaveLength(1);
  });
});

describe("tabSummary", () => {
  it("reads Off when empty", () => {
    expect(tabSummary([])).toEqual({ off: true, parts: ["Off"], text: "Off" });
  });
  it("reads a range for one unbroken run", () => {
    const s = tabSummary([P(0, "23:00", "01:00"), P(1, "01:00", "03:00")]);
    expect(s.off).toBe(false);
    expect(s.text).toBe("23:00–03:00");
    expect(s.parts).toEqual(["23:00", "–03:00"]);
  });
  it("reads a count when there is a gap, with a space that survives separate flex items", () => {
    const s = tabSummary([P(0, "21:00", "22:00"), P(0, "23:00", "01:00")]);
    expect(s.text).toBe("2 periods");
    // Each part is its own element: a leading plain space would collapse to "2periods".
    expect(s.parts).toEqual(["2", "\u00a0periods"]);
    expect(s.parts.every((part) => !/^\s/.test(part.replace(/\u00a0/g, "x")))).toBe(true);
  });
  it("labels the tab for screen readers", () => {
    expect(tabLabel("nights", 0, [P(0, "23:00", "01:00")])).toBe("Monday night: 23:00 to 01:00 Cool");
    expect(tabLabel("days", 2, [])).toBe("Wednesday: off");
  });
});

describe("carry-over", () => {
  it("lists periods from the previous window that run into this one", () => {
    const ps = [P(0, "23:00", "13:00", 23, "D"), P(1, "14:00", "15:00")];
    expect(carryOver(ps, 1, "nights")).toEqual([ps[0]]);
    expect(carryText("nights", 1, ps[0])).toBe("From Monday night: Dehumidify 23:00 → 13:00");
  });
  it("in days view, 23:00 → 03:00 carries into the next day", () => {
    const p = P(0, "23:00", "03:00");
    expect(carryOver([p], 1, "days")).toEqual([p]);
    expect(carryText("days", 1, p)).toBe("From Monday: Cool 23:00 → 03:00");
    expect(carryOver([p], 1, "nights")).toEqual([]);
  });
});

describe("bars", () => {
  it("places a night bar from noon, in percent", () => {
    const b = bars([P(0, "18:00", "00:00", 24, "F")], 0, "nights");
    expect(b).toEqual([{ left: 25, width: 25, mode: "F", spill: false }]);
  });
  it("draws the tail of a period from the previous day as a spill", () => {
    const b = bars([P(0, "18:00", "06:00", 24, "D")], 1, "days");
    expect(b).toEqual([{ left: 0, width: 25, mode: "D", spill: true }]);
    const own = bars([P(0, "18:00", "06:00", 24, "D")], 0, "days");
    expect(own).toEqual([{ left: 75, width: 25, mode: "D", spill: false }]);
  });
  it("marks 11:00", () => {
    expect(cutMark("days")).toBeCloseTo((660 / 1440) * 100);
    expect(cutMark("nights")).toBeCloseTo((1380 / 1440) * 100);
  });
});

describe("periodTag", () => {
  it("tags after-midnight starts in nights and next-day ends", () => {
    expect(periodTag("nights", P(1, "01:00", "03:00"))).toBe("after midnight");
    expect(periodTag("nights", P(0, "23:00", "01:00"))).toBe("ends next day");
    expect(periodTag("days", P(1, "01:00", "03:00"))).toBe("");
  });
});

describe("period rows", () => {
  it("says mode, setpoint and fan", () => {
    expect(periodWhat(P(0, "23:00", "01:00"))).toBe("Cool 24 °C · fan auto");
    expect(periodWhat(P(0, "23:00", "01:00", 25, "D", "MH"))).toBe("Dehumidify 25 °C · fan 4");
  });
  it("notices a draft running across 11:00", () => {
    expect(draftCrossesCut(draft("02:00", "11:30"), 0, "nights")).toBe(true);
    expect(draftCrossesCut(draft("02:00", "11:00"), 0, "nights")).toBe(false);
    expect(draftCrossesCut(draft("02:00", "02:00"), 0, "nights")).toBe(false);
  });
});

describe("cut-off wording", () => {
  it("names Daikin's hall system", () => {
    expect(CUT_NOTE).toBe("Daikin's hall system turns it off at 11:00; the app turns it back on at 11:01");
  });
});

describe("repeats", () => {
  const nightly = (start: string, end: string, nights: number[]) => nights.map((n) => P(dayFor(n, start, "nights"), start, end));
  it("is empty for a one-off", () => {
    const ps = nightly("23:00", "01:00", [0]);
    expect(repeatsText(ps, ps[0], "nights")).toBe("");
  });
  it("reads Every night", () => {
    const ps = nightly("23:00", "01:00", [0, 1, 2, 3, 4, 5, 6]);
    expect(repeatsText(ps, ps[2], "nights")).toBe("Repeats: Every night");
    expect(repeatsText(ps, ps[2], "days")).toBe("Repeats: Every day");
  });
  it("reads Weeknights for Sun–Thu nights, even for after-midnight copies", () => {
    const ps = nightly("01:00", "03:00", [6, 0, 1, 2, 3]);
    expect(repeatsText(ps, ps[0], "nights")).toBe("Repeats: Weeknights");
  });
  it("lists the nights otherwise", () => {
    const ps = nightly("23:00", "01:00", [0, 1, 3]);
    expect(repeatsText(ps, ps[0], "nights")).toBe("Repeats: Mon, Tue, Thu");
  });
  it("does not count copies with other settings", () => {
    const ps = [P(0, "23:00", "01:00"), P(1, "23:00", "01:00", 25)];
    expect(repeatsText(ps, ps[0], "nights")).toBe("");
  });
  it("finds identical copies and their windows", () => {
    const ps = [...nightly("01:00", "03:00", [0, 4]), P(3, "01:00", "03:00", 26)];
    expect(linkedTo(ps, ps[0])).toEqual([ps[0], ps[1]]);
    expect(repeatWindows(ps, ps[1], "nights")).toEqual([0, 4]);
    expect(repeatWindows(ps, ps[1], "days")).toEqual([1, 5]);
  });
});

describe("dayFor", () => {
  it("pins an after-midnight start to the next calendar day in nights", () => {
    expect(dayFor(6, "01:00", "nights")).toBe(0);
    expect(dayFor(6, "23:00", "nights")).toBe(6);
    expect(dayFor(6, "01:00", "days")).toBe(6);
  });
});

describe("planEdit: Repeats on", () => {
  it("adds 23:00 → 01:00 on Mo–Th", () => {
    const r = planEdit([], [], [0, 1, 2, 3], draft("23:00", "01:00"), "nights");
    expect(r.next.map((p) => p.day)).toEqual([0, 1, 2, 3]);
    expect(r.clash).toBeNull();
    expect(r.selfClash).toBe(false);
  });
  it("finds a clash with an existing period", () => {
    const existing = P(6, "23:00", "01:00");
    const r = planEdit([existing], [], [0], draft("00:00", "02:00"), "nights");
    expect(r.next[1].day).toBe(1);
    expect(r.clash).toBeNull();
    const r2 = planEdit([existing], [], [6], draft("00:00", "02:00"), "nights");
    expect(r2.clash).toBe(existing);
  });
  it("updates every linked copy and drops unticked ones", () => {
    const ps = [P(0, "23:00", "01:00"), P(1, "23:00", "01:00"), P(2, "23:00", "01:00"), P(4, "20:00", "21:00")];
    const linked = linkedTo(ps, ps[0]);
    const r = planEdit(ps, linked, [0, 2], draft("22:00", "01:00", { setpoint: 25 }), "nights");
    expect(r.next).toEqual([P(4, "20:00", "21:00"), P(0, "22:00", "01:00", 25), P(2, "22:00", "01:00", 25)]);
  });
  it("never lets same-time copies collide: they start 24 h apart and run under 24 h", () => {
    expect(planEdit([], [], [0, 1, 2, 3, 4, 5, 6], draft("12:01", "12:00"), "nights").selfClash).toBe(false);
  });
  it("deletes only from ticked windows", () => {
    const ps = [P(0, "23:00", "01:00"), P(1, "23:00", "01:00"), P(2, "23:00", "01:00")];
    expect(planDelete(ps, linkedTo(ps, ps[0]), [0, 2], "nights")).toEqual([ps[1]]);
  });
});

describe("editBlock", () => {
  const OVERLAP = "Overlaps Cool 23:00 → 01:00 on Sunday night.";
  it("names the overlap", () => {
    expect(editBlock([P(6, "23:00", "01:00")], [], [6], draft("00:00", "02:00"), "nights")).toBe(OVERLAP);
  });
  it("blocks an 11:00 start with Daikin's copy", () => {
    expect(editBlock([], [], [0], draft("11:00", "12:00"), "nights")).toBe(
      "Daikin's hall system switches every aircon off at 11:00. Start at 11:01 or later.",
    );
  });
  it("needs one window and a length", () => {
    expect(editBlock([], [], [], draft("23:00", "01:00"), "days")).toBe("Pick at least one day.");
    expect(editBlock([], [], [0], draft("23:00", "23:00"), "nights")).toBe("Off time must differ from on time.");
    expect(editBlock([], [], [0], draft("", "01:00"), "nights")).toBe("Enter both times.");
  });
  it("is null when the save can go ahead", () => {
    expect(editBlock([], [], [0], draft("23:00", "01:00"), "nights")).toBeNull();
  });
});

describe("runsText", () => {
  it("describes the length and where it ends", () => {
    expect(runsText(draft("23:00", "01:30"), "nights")).toBe("Runs 2 h 30 min, ending the next day.");
    expect(runsText(draft("01:00", "03:00"), "nights")).toBe("Runs 2 h, after midnight (still counts as the night before).");
    expect(runsText(draft("01:00", "03:00"), "days")).toBe("Runs 2 h.");
    expect(runsText(draft("01:00", "01:00"), "days")).toBe("Off time must differ from on time.");
  });
});

describe("defaultDraft", () => {
  it("starts where the last period ends, for two hours", () => {
    expect(defaultDraft([P(0, "23:00", "01:00", 25, "D", "L")])).toEqual(draft("01:00", "03:00", { setpoint: 25, mode: "D", fan: "L" }));
  });
  it("is 23:00 → 03:00 Cool 24 auto on an empty window", () => {
    expect(defaultDraft([])).toEqual(draft("23:00", "03:00"));
  });
});

describe("planCopy", () => {
  it("replaces the targets' periods with shifted copies", () => {
    const ps = [P(4, "23:00", "01:00"), P(5, "01:00", "03:00", 25), P(1, "20:00", "21:00")];
    const r = planCopy(ps, 4, [1, 2], "nights");
    expect(r.clash).toBeNull();
    expect(r.next).toEqual([
      P(4, "23:00", "01:00"),
      P(5, "01:00", "03:00", 25),
      P(1, "23:00", "01:00"),
      P(2, "01:00", "03:00", 25),
      P(2, "23:00", "01:00"),
      P(3, "01:00", "03:00", 25),
    ]);
  });
  it("finds a clash with a neighbouring window", () => {
    // Monday night's long period lands on Tuesday night (Tue 13:00 → Wed 11:30); Wednesday night starts at 23:00.
    const ps = [P(0, "13:00", "11:30"), P(2, "23:00", "01:00")];
    const r = planCopy(ps, 0, [1], "nights");
    expect(r.clash).toBeNull();
    const clashy = [P(0, "13:00", "11:30"), P(2, "10:00", "12:00")];
    const r2 = planCopy(clashy, 0, [1], "days");
    expect(r2.clash?.other).toBe(clashy[1]);
    expect(r2.clash?.target).toBe(1);
    expect(r2.text).toBe("On Tuesday this would overlap Cool 10:00 → 12:00 on Wednesday. Change that day first.");
  });
});

describe("problemText", () => {
  const ps = [P(6, "23:00", "01:00"), P(0, "00:00", "02:00")];
  it("maps codes to the dialog's copy", () => {
    expect(problemText({ code: "overlap", index: 1, other: 0 }, ps, "nights")).toBe("Overlaps Cool 23:00 → 01:00 on Sunday night.");
    expect(problemText({ code: "start-1100", index: 0 }, ps, "nights")).toBe(
      "Daikin's hall system switches every aircon off at 11:00. Start at 11:01 or later.",
    );
    expect(problemText({ code: "zero-length", index: 0 }, ps, "nights")).toBe("Off time must differ from on time.");
    expect(problemText({ code: "setpoint", index: 0 }, ps, "nights")).toBe("The hall allows 22–26 °C.");
    expect(problemText(undefined, ps, "nights")).toBe("Couldn't save the schedule. Try again.");
  });
});

describe("periodAt and Apply now", () => {
  const p = P(0, "23:00", "01:00");
  it("finds the period covering now, in Singapore time, across the week wrap", () => {
    expect(periodAt([p], at(0, "23:30"))).toBe(p);
    expect(periodAt([p], at(1, "00:59"))).toBe(p);
    expect(periodAt([p], at(1, "01:00"))).toBeUndefined();
    const sun = P(6, "23:00", "02:00");
    expect(periodAt([sun], at(0, "01:00"))).toBe(sun);
  });
  it("offers Apply now when the save created a period covering now", () => {
    expect(offersApplyNow(sched([]), sched([p]), at(0, "23:30"))).toBe(true);
  });
  it("offers Apply now when the save changed the period covering now", () => {
    expect(offersApplyNow(sched([p]), sched([{ ...p, setpoint: 22 }]), at(0, "23:30"))).toBe(true);
  });
  it("does not offer it for an untouched period, outside periods, or when paused", () => {
    expect(offersApplyNow(sched([p]), sched([p, P(3, "20:00", "21:00")]), at(0, "23:30"))).toBe(false);
    expect(offersApplyNow(sched([]), sched([p]), at(0, "22:00"))).toBe(false);
    expect(offersApplyNow(sched([]), sched([p], { enabled: false }), at(0, "23:30"))).toBe(false);
  });
});

describe("status and cost", () => {
  it("says nothing switches when paused", () => {
    expect(statusText(sched([P(0, "23:00", "01:00")], { enabled: false }), MON)).toEqual({
      on: false,
      title: "Schedule is paused",
      line: "Nothing will switch automatically. Your nights are kept.",
    });
    expect(statusText(sched([], { enabled: false, view: "days" }), MON).line).toBe("Nothing will switch automatically. Your days are kept.");
  });
  it("asks for a first period", () => {
    expect(statusText(sched([]), MON).line).toBe("Pick a night below and add a period.");
  });
  it("shows the next change today without a day, later with one", () => {
    const ps = [P(0, "23:00", "01:00")];
    expect(statusText(sched(ps), at(0, "20:00")).line).toBe("Next: On 24 °C Cool, fan auto at 23:00");
    expect(statusText(sched(ps), at(0, "23:30")).line).toBe("Next: Off at 01:00 · Tue");
  });
  it("prices the week", () => {
    expect(costText([P(0, "23:00", "01:00"), P(1, "23:00", "01:00")])).toBe("S$1.56 · 4 h");
    expect(costText([])).toBe("S$0.00 · 0 h");
  });
});

describe("windowAt", () => {
  it("picks tonight in Singapore time", () => {
    expect(windowAt(at(0, "11:59"), "nights")).toBe(6);
    expect(windowAt(at(0, "12:00"), "nights")).toBe(0);
    expect(windowAt(at(0, "11:59"), "days")).toBe(0);
  });
});

describe("activity", () => {
  it("formats time in Singapore time", () => {
    expect(activityTime(at(5, "23:05"))).toBe("Sat 7 Nov, 23:05");
  });
  it("reads result and reason", () => {
    const a: Activity = { id: 1, at: 0, kind: "start", summary: "On 24 °C Cool, fan auto", result: "failed", reason: "the aircon didn't respond" };
    expect(activityLine(a)).toEqual({ label: "Failed", text: "On 24 °C Cool, fan auto", reason: "the aircon didn't respond" });
    expect(activityLine({ ...a, result: "done", reason: undefined })).toEqual({ label: "Done", text: "On 24 °C Cool, fan auto", reason: "" });
  });
});
