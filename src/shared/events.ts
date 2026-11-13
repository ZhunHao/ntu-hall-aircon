// Schedule events and Singapore time. Pure: the Durable Object's alarm loop and the browser share it.
// The Worker clock is UTC, so every wall-clock reading goes through SGT (fixed UTC+8, no daylight saving).
import { cuts, span, WEEK, type Fan, type Mode, type Period } from "./schedule";

export type EventKind = "start" | "end" | "resume";
/** `at` is a week minute, 0..WEEK-1 (Monday 00:00 SGT = 0). `id` = `${kind}@${at}`. */
export interface SchedEvent {
  at: number;
  kind: EventKind;
  period: Period;
  id: string;
}

const MIN = 60e3;
const SGT_OFFSET = 8 * 3600e3;
const WEEK_MS = WEEK * MIN;
// Order of events that share a minute. The last one wins when only one may run:
// a start beats an end or resume (the aircon should be on), an end beats a resume.
const RANK: Record<EventKind, number> = { resume: 0, end: 1, start: 2 };

/** Events for one week, ascending by `at`. Callers pass valid periods only. */
export function weekEvents(periods: Period[]): SchedEvent[] {
  const all: SchedEvent[] = [];
  const add = (kind: EventKind, minute: number, period: Period) => {
    const at = ((minute % WEEK) + WEEK) % WEEK;
    all.push({ at, kind, period, id: `${kind}@${at}` });
  };
  for (const p of periods) {
    const x = span(p);
    add("start", x.s, p);
    add("end", x.e, p);
    for (const c of cuts(x)) add("resume", c + 1, p);
  }
  // Back-to-back periods: B's start replaces A's end, so the aircon is never switched off between them.
  const starts = new Set(all.filter((e) => e.kind === "start").map((e) => e.at));
  return all
    .filter((e) => e.kind !== "end" || !starts.has(e.at))
    .sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
}

/** Minutes since Monday 00:00 SGT, 0..WEEK-1. */
export function sgtWeekMinute(epochMs: number): number {
  const d = new Date(epochMs + SGT_OFFSET);
  return ((d.getUTCDay() + 6) % 7) * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Epoch ms of the Monday 00:00 SGT that starts the week containing `epochMs`. */
function weekStartMs(epochMs: number): number {
  return Math.floor(epochMs / MIN) * MIN - sgtWeekMinute(epochMs) * MIN;
}

/** First event strictly after `nowMs`, looking into next week when needed. */
export function nextEventAfter(periods: Period[], nowMs: number): { ev: SchedEvent; atMs: number } | null {
  const base = weekStartMs(nowMs);
  let best: { ev: SchedEvent; atMs: number } | null = null;
  for (const ev of weekEvents(periods)) {
    let atMs = base + ev.at * MIN;
    if (atMs <= nowMs) atMs += WEEK_MS;
    if (!best || atMs <= best.atMs) best = { ev, atMs }; // ties: the later-ranked event wins
  }
  return best;
}

/**
 * The latest event occurrence at or before `nowMs` (possibly last week), if it hasn't run and isn't stale.
 * Only the latest is considered: an older missed event is never replayed, so state catches up to what should hold now.
 */
export function dueEvent(
  periods: Period[],
  nowMs: number,
  doneKeys: Set<string>,
  staleMs = 30 * MIN,
): { ev: SchedEvent; atMs: number; key: string } | null {
  const base = weekStartMs(nowMs);
  let latest: { ev: SchedEvent; atMs: number } | null = null;
  for (const ev of weekEvents(periods)) {
    let atMs = base + ev.at * MIN;
    if (atMs > nowMs) atMs -= WEEK_MS;
    if (!latest || atMs >= latest.atMs) latest = { ev, atMs };
  }
  if (!latest || nowMs - latest.atMs > staleMs) return null;
  const key = `${latest.ev.id}#${latest.atMs}`;
  return doneKeys.has(key) ? null : { ...latest, key };
}

const MODE_WORDS: Record<Mode, string> = { C: "Cool", D: "Dehumidify", F: "Fan", A: "Auto" };
// The UI fan buttons Auto/1/2/3/4/5 are Daikin's A/L/LM/M/MH/H.
const FAN_WORDS: Record<Fan, string> = { A: "auto", L: "1", LM: "2", M: "3", MH: "4", H: "5" };

/** "On 23 °C Cool, fan auto". */
export function onSummary(p: Pick<Period, "setpoint" | "mode" | "fan">): string {
  return `On ${p.setpoint} °C ${MODE_WORDS[p.mode]}, fan ${FAN_WORDS[p.fan]}`;
}

/** What an event does, in the activity log's words. */
export function eventSummary(ev: SchedEvent): string {
  if (ev.kind === "start") return onSummary(ev.period);
  if (ev.kind === "end") return "Off";
  return "Back on after Daikin's 11:00 cut-off";
}
