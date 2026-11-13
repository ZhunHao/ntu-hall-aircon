// Schedule maths. Pure: shared by the Durable Object, the alarm and the browser.
// Times are Singapore time (fixed UTC+8). Week minute 0 = Monday 00:00.

export type Mode = "C" | "D" | "F" | "A";
export type Fan = "A" | "L" | "LM" | "M" | "MH" | "H";
export type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Monday
export type View = "nights" | "days";
export interface Period {
  day: Day;
  start: string;
  end: string;
  setpoint: number;
  mode: Mode;
  fan: Fan;
}
export interface Schedule {
  periods: Period[];
  enabled: boolean;
  view: View;
}
/** Week minutes; `e` may exceed WEEK when a period wraps past Sunday night. */
export interface Span {
  s: number;
  e: number;
}
export type Problem = {
  code: "day" | "time" | "zero-length" | "start-1100" | "setpoint" | "mode" | "fan" | "overlap";
  index: number;
  other?: number;
};

export const WEEK = 10080;
export const CUT = 660; // Daikin's hall system switches every aircon off at 11:00
export const RATE_PER_HOUR = 0.39;

const DAY = 1440;
const MODES: readonly string[] = ["C", "D", "F", "A"];
const FANS: readonly string[] = ["A", "L", "LM", "M", "MH", "H"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Where a night/day window starts, in minutes after midnight.
const WINDOW_START: Record<View, number> = { nights: 720, days: 0 };

export function mins(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Length in minutes. End before start crosses midnight; equal times give 0 (invalid). */
export function dur(p: Period): number {
  return (mins(p.end) - mins(p.start) + DAY) % DAY;
}

export function span(p: Period): Span {
  const s = p.day * DAY + mins(p.start);
  return { s, e: s + dur(p) };
}

export function overlaps(a: Span, b: Span): boolean {
  return [-WEEK, 0, WEEK].some((shift) => a.s < b.e + shift && b.s + shift < a.e);
}

/** Week minutes of every 11:00 strictly inside the span. */
export function cuts(x: Span): number[] {
  const out: number[] = [];
  for (let k = Math.floor(x.s / DAY); k <= Math.floor(x.e / DAY); k++) {
    const c = k * DAY + CUT;
    if (c > x.s && c < x.e) out.push(c);
  }
  return out;
}

/** The night (noon to noon) or day (midnight to midnight) a period starts in. */
export function groupOf(p: Period, view: View): Day {
  return Math.floor(((span(p).s - WINDOW_START[view] + WEEK) % WEEK) / DAY) as Day;
}

export function samePeriod(a: Period, b: Period): boolean {
  return a.start === b.start && a.end === b.end && a.setpoint === b.setpoint && a.mode === b.mode && a.fan === b.fan;
}

/** Problems in period-index order. Periods with a bad day, bad time or zero length are left out of overlap checks. */
export function validate(s: Schedule): Problem[] {
  const out: Problem[] = [];
  const spans: (Span | null)[] = [];
  s.periods.forEach((p, index) => {
    let sp: Span | null = null;
    const dayOk = Number.isInteger(p.day) && p.day >= 0 && p.day <= 6;
    if (!dayOk) out.push({ code: "day", index });
    if (!HHMM.test(p.start) || !HHMM.test(p.end)) {
      out.push({ code: "time", index });
    } else if (p.start === p.end) {
      out.push({ code: "zero-length", index });
    } else {
      if (dayOk) sp = span(p);
      if (mins(p.start) === CUT) out.push({ code: "start-1100", index });
    }
    if (!MODES.includes(p.mode)) out.push({ code: "mode", index });
    if (!FANS.includes(p.fan)) out.push({ code: "fan", index });
    if (!Number.isInteger(p.setpoint) || p.setpoint < 22 || p.setpoint > 26) out.push({ code: "setpoint", index });
    spans.push(sp);
    if (sp) {
      spans.forEach((other, j) => {
        if (j < index && other && overlaps(sp, other)) out.push({ code: "overlap", index, other: j });
      });
    }
  });
  return out;
}

/** Hours on at S$0.39/h, one minute less per 11:00 cut-off. `sgd` is rounded to cents. */
export function weeklyCost(periods: Period[]): { minutes: number; sgd: number } {
  let minutes = 0;
  for (const p of periods) {
    const x = span(p);
    minutes += x.e - x.s - cuts(x).length;
  }
  return { minutes, sgd: Math.round((minutes / 60) * RATE_PER_HOUR * 100) / 100 };
}
