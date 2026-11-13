// Pure logic for the Schedule page: kept out of pages/schedule.ts so it can be unit tested without a browser.
// The maths (spans, overlaps, cut-offs, cost) is src/shared/schedule.ts; this file only groups and words it.
// Times are Singapore time throughout: "now" goes through sgtWeekMinute, never the browser's clock fields.
import type { Activity } from "../../shared/api";
import { eventSummary, nextEventAfter, sgtWeekMinute } from "../../shared/events";
import {
  CUT,
  cuts,
  dur,
  groupOf,
  mins,
  overlaps,
  samePeriod,
  span,
  weeklyCost,
  WEEK,
  type Day,
  type Fan,
  type Mode,
  type Period,
  type Problem,
  type Schedule,
  type Span,
  type View,
} from "../../shared/schedule";
import { fanLabel, sgd } from "./format";

const DAY = 1440;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MODE_NAME: Record<Mode, string> = { C: "Cool", D: "Dehumidify", F: "Fan", A: "Auto" };
/** The period-row note for a period that runs across 11:00. */
export const CUT_NOTE = "Daikin's hall system turns it off at 11:00; the app turns it back on at 11:01";
export const DAIKIN_1100 = "Daikin's hall system switches every aircon off at 11:00. Start at 11:01 or later.";
const ALL = [0, 1, 2, 3, 4, 5, 6];

export type QuickKey = "work" | "weekend" | "all";
export interface ViewText {
  /** Minutes after midnight where a window starts. */
  origin: number;
  noun: string;
  nouns: string;
  axis: string[];
  explain: string;
  quick: Record<QuickKey, { label: string; windows: number[] }>;
}

export const VIEWS: Record<View, ViewText> = {
  nights: {
    origin: 720,
    noun: "night",
    nouns: "nights",
    axis: ["12:00", "18:00", "00:00", "06:00", "12:00"],
    explain:
      "Each night runs from noon to noon, so 01:00 belongs to the night before and one night's sleep stays in one place. Tap a night to edit it, then copy it to other nights.",
    quick: {
      work: { label: "Weeknights (Sun–Thu)", windows: [6, 0, 1, 2, 3] },
      weekend: { label: "Weekend (Fri & Sat)", windows: [4, 5] },
      all: { label: "Every night", windows: ALL },
    },
  },
  days: {
    origin: 0,
    noun: "day",
    nouns: "days",
    axis: ["00:00", "06:00", "12:00", "18:00", "24:00"],
    explain:
      "Each day runs from midnight to midnight, like most thermostat apps. A period belongs to the day it starts on, so 23:00 → 03:00 sits on the first day and carries into the next (shown faded). Tap a day to edit it, then copy it to other days.",
    quick: {
      work: { label: "Weekdays (Mon–Fri)", windows: [0, 1, 2, 3, 4] },
      weekend: { label: "Weekend (Sat & Sun)", windows: [5, 6] },
      all: { label: "Every day", windows: ALL },
    },
  },
};

/** "Friday night" or "Friday". */
export function windowTitle(view: View, n: number): string {
  return view === "nights" ? `${LONG[n]} night` : LONG[n];
}

/** "Fri 12:00 → Sat 12:00" or "Fri 00:00 → 24:00". */
export function windowSub(view: View, n: number): string {
  return view === "nights" ? `${DAYS[n]} 12:00 → ${DAYS[(n + 1) % 7]} 12:00` : `${DAYS[n]} 00:00 → 24:00`;
}

/** Minutes from the start of window n to the start of x. */
function offset(n: number, x: Span, view: View): number {
  return (x.s - (n * DAY + VIEWS[view].origin) + 2 * WEEK) % WEEK;
}

/** Periods that start in window n, in order from the window's start. */
export function group(periods: Period[], n: number, view: View): Period[] {
  return periods
    .filter((p) => groupOf(p, view) === n)
    .sort((a, b) => offset(n, span(a), view) - offset(n, span(b), view));
}

/** The calendar day a period starts on, from the window it is added to and its start time. */
export function dayFor(n: number, start: string, view: View): Day {
  return ((n + (mins(start) < VIEWS[view].origin ? 1 : 0)) % 7) as Day;
}

/** The window (night or day) holding `nowMs`, in Singapore time. */
export function windowAt(nowMs: number, view: View): Day {
  const m = sgtWeekMinute(nowMs);
  return Math.floor(((m - VIEWS[view].origin + WEEK) % WEEK) / DAY) as Day;
}

// ---------- Tabs ----------
const NBSP = "\u00a0";

/**
 * Tab text: "Off", a range for one unbroken run ("23:00–03:00"), otherwise a count ("2 periods").
 * `parts` are rendered as separate flex items (they stack on narrow screens), where a plain leading space would
 * collapse, so the count's space is a no-break space. `text` is the same with ordinary spaces.
 */
export function tabSummary(list: Period[]): { off: boolean; parts: string[]; text: string } {
  if (!list.length) return { off: true, parts: ["Off"], text: "Off" };
  const joined = list.every((p, i) => i === 0 || list[i - 1].end === p.start);
  const parts = joined ? [list[0].start, `–${list[list.length - 1].end}`] : [String(list.length), `${NBSP}periods`];
  return { off: false, parts, text: parts.join("").replaceAll(NBSP, " ") };
}

/** "Monday night: 23:00 to 01:00 Cool" for screen readers. */
export function tabLabel(view: View, n: number, list: Period[]): string {
  const what = list.length ? list.map((p) => `${p.start} to ${p.end} ${MODE_NAME[p.mode]}`).join(", ") : "off";
  return `${windowTitle(view, n)}: ${what}`;
}

// ---------- One window ----------
/** Periods from the previous window that run into window n. They are shown here and edited where they start. */
export function carryOver(periods: Period[], n: number, view: View): Period[] {
  const prev = (n + 6) % 7;
  return group(periods, prev, view).filter((p) => {
    const x = span(p);
    return offset(prev, x, view) + (x.e - x.s) > DAY;
  });
}

/** "From Thursday night: Cool 23:00 → 13:00". `n` is the window being shown. */
export function carryText(view: View, n: number, p: Period): string {
  return `From ${windowTitle(view, (n + 6) % 7)}: ${MODE_NAME[p.mode]} ${p.start} → ${p.end}`;
}

/** A bar in a window's track, in percent of the window. `spill` is the faded tail of the previous window's period. */
export interface Bar {
  left: number;
  width: number;
  mode: Mode;
  spill: boolean;
}

const pct = (minutes: number): number => (minutes / DAY) * 100;

export function bars(periods: Period[], n: number, view: View): Bar[] {
  const prev = (n + 6) % 7;
  const tails: Bar[] = [];
  for (const p of group(periods, prev, view)) {
    const x = span(p);
    const over = offset(prev, x, view) + (x.e - x.s) - DAY;
    if (over > 0) tails.push({ left: 0, width: pct(Math.min(over, DAY)), mode: p.mode, spill: true });
  }
  const own = group(periods, n, view).map((p): Bar => {
    const x = span(p);
    const l = offset(n, x, view);
    return { left: pct(l), width: pct(Math.min(DAY - l, x.e - x.s)), mode: p.mode, spill: false };
  });
  return [...tails, ...own];
}

/** Where 11:00 sits in a window, in percent. */
export function cutMark(view: View): number {
  return pct((CUT - VIEWS[view].origin + DAY) % DAY);
}

/** The small line under a period's times: "after midnight" (nights), "ends next day", or "". */
export function periodTag(view: View, p: Period): string {
  if (view === "nights" && mins(p.start) < VIEWS.nights.origin) return "after midnight";
  return mins(p.end) <= mins(p.start) ? "ends next day" : "";
}

/** What a period row says: "Cool 24 °C · fan auto". */
export function periodWhat(p: Period): string {
  return `${MODE_NAME[p.mode]} ${p.setpoint} °C · fan ${p.fan === "A" ? "auto" : fanLabel(p.fan)}`;
}

/** True when a period runs across the 11:00 cut-off by Daikin's hall system. */
export function crossesCut(p: Period): boolean {
  return cuts(span(p)).length > 0;
}

// ---------- Repeats ----------
/** The period and its identical copies (same times and settings) on other windows. */
export function linkedTo(periods: Period[], p: Period): Period[] {
  return periods.filter((q) => samePeriod(q, p));
}

/** Windows that hold an identical copy of `p`, ascending. */
export function repeatWindows(periods: Period[], p: Period, view: View): number[] {
  return [...new Set(linkedTo(periods, p).map((q) => groupOf(q, view)))].sort((a, b) => a - b);
}

/** "Repeats: Every night", "Repeats: Weeknights", "Repeats: Mon, Tue", or "" for a one-off. */
export function repeatsText(periods: Period[], p: Period, view: View): string {
  const on = repeatWindows(periods, p, view);
  if (on.length < 2) return "";
  const named = Object.values(VIEWS[view].quick).find((q) => q.windows.length === on.length && q.windows.every((n) => on.includes(n)));
  return `Repeats: ${named ? named.label.replace(/ \(.*\)/, "") : on.map((n) => DAYS[n]).join(", ")}`;
}

// ---------- Add / edit ----------
/** The dialog's fields. Times are "HH:MM", or "" when a field is blank. */
export interface Draft {
  start: string;
  end: string;
  setpoint: number;
  mode: Mode;
  fan: Fan;
}

const hhmm = (m: number): string => {
  const d = ((m % DAY) + DAY) % DAY;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

/** A new period starts where the window's last one ends, for two hours, with its settings; else 23:00 → 03:00. */
export function defaultDraft(list: Period[]): Draft {
  const last = list[list.length - 1];
  if (!last) return { start: "23:00", end: "03:00", setpoint: 24, mode: "C", fan: "A" };
  return { start: last.end, end: hhmm(mins(last.end) + 120), setpoint: last.setpoint, mode: last.mode, fan: last.fan };
}

function placed(d: Draft, n: number, view: View): Period {
  return { day: dayFor(n, d.start, view), start: d.start, end: d.end, setpoint: d.setpoint, mode: d.mode, fan: d.fan };
}

const draftLen = (d: Draft): number => (d.start && d.end ? dur({ ...d, day: 0 }) : 0);

/** "Runs 2 h 30 min, ending the next day." */
export function runsText(d: Draft, view: View): string {
  if (!d.start || !d.end) return "";
  const len = draftLen(d);
  if (!len) return "Off time must differ from on time.";
  const where =
    view === "nights" && mins(d.start) < VIEWS.nights.origin
      ? ", after midnight (still counts as the night before)"
      : mins(d.end) <= mins(d.start)
        ? ", ending the next day"
        : "";
  return `Runs ${Math.floor(len / 60)} h${len % 60 ? ` ${len % 60} min` : ""}${where}.`;
}

/** True when the draft, placed on window n, runs across 11:00 (the dialog then explains the 11:01 resume). */
export function draftCrossesCut(d: Draft, n: number, view: View): boolean {
  return draftLen(d) > 0 && crossesCut(placed(d, n, view));
}

export interface EditPlan {
  /** The whole schedule's periods after the save: everything else, then the new copies. */
  next: Period[];
  added: Period[];
  /** Copies collide with each other (a long period on back-to-back windows). */
  selfClash: boolean;
  /** The first other period a copy overlaps. */
  clash: Period | null;
}

/**
 * Saving puts the draft on every ticked window. The period being edited and its identical copies (`linked`)
 * are replaced, so unticking a window removes the copy there.
 */
export function planEdit(periods: Period[], linked: Period[], repeat: number[], d: Draft, view: View): EditPlan {
  const added = repeat.map((n) => placed(d, n, view));
  const base = periods.filter((p) => !linked.includes(p));
  const len = draftLen(d);
  const spans = len ? added.map(span) : [];
  const selfClash = spans.some((a, i) => spans.some((b, j) => i < j && overlaps(a, b)));
  let clash: Period | null = null;
  for (const a of spans) {
    clash = base.find((q) => overlaps(a, span(q))) ?? null;
    if (clash) break;
  }
  return { next: base.concat(added), added, selfClash, clash };
}

/** Delete removes the linked copies on the ticked windows only. */
export function planDelete(periods: Period[], linked: Period[], repeat: number[], view: View): Period[] {
  return periods.filter((p) => !(linked.includes(p) && repeat.includes(groupOf(p, view))));
}

const overlapText = (q: Period, view: View): string =>
  `Overlaps ${MODE_NAME[q.mode]} ${q.start} → ${q.end} on ${windowTitle(view, groupOf(q, view))}.`;

/** Why Save is blocked, or null. The 11:00 copy is Daikin's rule, verbatim. */
export function editBlock(periods: Period[], linked: Period[], repeat: number[], d: Draft, view: View): string | null {
  if (!d.start || !d.end) return "Enter both times.";
  if (!draftLen(d)) return "Off time must differ from on time.";
  if (mins(d.start) === CUT) return DAIKIN_1100;
  const v = VIEWS[view];
  if (!repeat.length) return `Pick at least one ${v.noun}.`;
  const r = planEdit(periods, linked, repeat, d, view);
  if (r.selfClash) return `Too long to repeat on back-to-back ${v.nouns}.`;
  if (r.clash) return overlapText(r.clash, view);
  return null;
}

// ---------- Copy ----------
export interface CopyPlan {
  next: Period[];
  clash: { target: number; other: Period } | null;
  /** The blocking message, or "". */
  text: string;
}

/** Targets lose their own periods and get copies of window `sel`'s, shifted by whole days. */
export function planCopy(periods: Period[], sel: number, targets: number[], view: View): CopyPlan {
  const source = group(periods, sel, view);
  const kept = periods.filter((p) => !targets.includes(groupOf(p, view)));
  const copies = targets.flatMap((t) => source.map((p) => ({ target: t, p: { ...p, day: ((p.day + t - sel + 7) % 7) as Day } })));
  const next = kept.concat(copies.map((c) => c.p));
  let clash: CopyPlan["clash"] = null;
  for (const c of copies) {
    const a = span(c.p);
    const other = next.find((q) => q !== c.p && overlaps(a, span(q)));
    if (other) {
      clash = { target: c.target, other };
      break;
    }
  }
  const v = VIEWS[view];
  const text = clash
    ? `On ${windowTitle(view, clash.target)} this would overlap ${MODE_NAME[clash.other.mode]} ${clash.other.start} → ${clash.other.end} on ${windowTitle(view, groupOf(clash.other, view))}. Change that ${v.noun} first.`
    : "";
  return { next, clash, text };
}

// ---------- Server answers ----------
/** The first problem from a 400 `{error:"invalid", problems}`, in the dialog's words. `periods` is what was sent. */
export function problemText(problem: Problem | undefined, periods: Period[], view: View): string {
  if (!problem) return "Couldn't save the schedule. Try again.";
  switch (problem.code) {
    case "overlap": {
      const q = periods[problem.other ?? problem.index];
      return q ? overlapText(q, view) : "Two periods overlap.";
    }
    case "start-1100":
      return DAIKIN_1100;
    case "zero-length":
      return "Off time must differ from on time.";
    case "setpoint":
      return "The hall allows 22–26 °C.";
    case "mode":
      return "Pick a mode.";
    case "fan":
      return "Pick a fan speed.";
    default:
      return "Check the on and off times.";
  }
}

/** The period running at `nowMs` (Singapore time), counting a Sunday-night period that wraps into Monday. */
export function periodAt(periods: Period[], nowMs: number): Period | undefined {
  const m = sgtWeekMinute(nowMs);
  return periods.find((p) => {
    const x = span(p);
    return (m >= x.s && m < x.e) || (m + WEEK >= x.s && m + WEEK < x.e);
  });
}

/** Saving never switches the aircon; offer Apply now when the save created or changed an enabled period covering now. */
export function offersApplyNow(before: Schedule, after: Schedule, nowMs: number): boolean {
  if (!after.enabled) return false;
  const p = periodAt(after.periods, nowMs);
  if (!p) return false;
  return !before.periods.some((q) => q.day === p.day && samePeriod(q, p));
}

// ---------- Status ----------
const SGT_OFFSET = 8 * 3_600_000;
const sgtDate = (ms: number): Date => new Date(ms + SGT_OFFSET);
const clock = (d: Date): string => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const sameSgtDay = (a: number, b: number): boolean => Math.floor((a + SGT_OFFSET) / 86_400_000) === Math.floor((b + SGT_OFFSET) / 86_400_000);

/** The status card's title and line: paused, empty, or "Next: On 23 °C Cool, fan auto at 01:00 · Sat". */
export function statusText(s: Schedule, nowMs: number): { on: boolean; title: string; line: string } {
  const v = VIEWS[s.view];
  if (!s.enabled) return { on: false, title: "Schedule is paused", line: `Nothing will switch automatically. Your ${v.nouns} are kept.` };
  const next = s.periods.length ? nextEventAfter(s.periods, nowMs) : null;
  if (!next) return { on: true, title: "Schedule is on", line: `Pick a ${v.noun} below and add a period.` };
  const d = sgtDate(next.atMs);
  const day = sameSgtDay(next.atMs, nowMs) ? "" : ` · ${DAYS[(d.getUTCDay() + 6) % 7]}`;
  return { on: true, title: "Schedule is on", line: `Next: ${eventSummary(next.ev)} at ${clock(d)}${day}` };
}

/** "S$12.48 · 32 h" for the week. */
export function costText(periods: Period[]): string {
  const c = weeklyCost(periods);
  return `${sgd(c.sgd)} · ${Math.round(c.minutes / 60)} h`;
}

// ---------- Activity ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 7 Nov, 23:05" in Singapore time. */
export function activityTime(ms: number): string {
  const d = sgtDate(ms);
  return `${DAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${clock(d)}`;
}

const RESULT_LABEL: Record<Activity["result"], string> = { done: "Done", skipped: "Skipped", failed: "Failed" };

/** What an activity row says. `reason` may echo Daikin's text: render it with textContent. */
export function activityLine(a: Activity): { label: string; text: string; reason: string } {
  return { label: RESULT_LABEL[a.result] ?? a.result, text: a.summary, reason: a.reason ?? "" };
}
