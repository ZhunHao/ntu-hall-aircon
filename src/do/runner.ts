// The schedule alarm: run the due event, confirm it took, and work out when to wake next.
// Every function takes `now` so tests need no clock. Nothing here throws on a Daikin failure.
import type { Activity } from "../shared/api";
import { dueEvent, eventSummary, nextEventAfter, sgtWeekMinute } from "../shared/events";
import { span, WEEK, type Period, type Schedule } from "../shared/schedule";
import { DaikinError, DaikinExpired, type Aircon, type Control, type Daikin } from "./daikin";
import type { Store } from "./store";

/** A control call waiting for its follow-up `/me` check. `kind` and `summary` are what gets logged. */
export interface Pending {
  checkAtMs: number;
  key: string;
  expect: Control;
  retried: boolean;
  kind: Activity["kind"];
  summary: string;
}

export interface RunCtx {
  store: Store;
  daikin: () => Promise<Daikin>;
  /** When this run started: picks the due event and stamps the log. */
  now: number;
  /** The time after a Daikin call returns, for confirm checks. Defaults to `Date.now`. */
  clock?: () => number;
}

export const DEFAULT_SCHEDULE: Schedule = { periods: [], enabled: true, view: "nights" };
const CONFIRM_MS = 10_000;
const KEEP_DONE = 50;
const SGT_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
// Daikin's timestamps, e.g. 2026-10-19T04:25:03.000+08:00.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const checkAt = (ctx: RunCtx): number => (ctx.clock ?? Date.now)() + CONFIRM_MS;

export function loadSchedule(store: Store): Schedule {
  return store.get<Schedule>("schedule") ?? DEFAULT_SCHEDULE;
}

/** The power-on command for a period. Swing (`flap`) is left as it is. */
export function startCommand(p: Period): Control {
  return { power: 1, setpoint: p.setpoint, mode: p.mode, fanstep: p.fan };
}

/** The period whose span covers `nowMs`, if any. */
export function periodAt(periods: Period[], nowMs: number): Period | undefined {
  const m = sgtWeekMinute(nowMs);
  return periods.find((p) => {
    const x = span(p);
    return (m >= x.s && m < x.e) || (m + WEEK >= x.s && m + WEEK < x.e);
  });
}

/** Earliest of the pending confirm check and the next event; null when signed out, expired or idle. */
export function nextWake(store: Store, now: number): number | null {
  if (store.get<string>("jwt") === undefined || store.get<boolean>("expired") === true) return null;
  const times: number[] = [];
  const p = store.get<Pending>("pending");
  if (p) times.push(p.checkAtMs);
  const s = loadSchedule(store);
  if (s.enabled) {
    const next = nextEventAfter(s.periods, now);
    if (next) times.push(next.atMs);
  }
  return times.length ? Math.min(...times) : null;
}

/** The latest due occurrence that hasn't run, or null. Occurrences before the last save never run: saving never switches. */
export function findDue(store: Store, now: number): ReturnType<typeof dueEvent> {
  const s = loadSchedule(store);
  if (!s.enabled) return null;
  const due = dueEvent(s.periods, now, new Set(store.get<string[]>("done") ?? []));
  return due && due.atMs >= (store.get<number>("savedAt") ?? 0) ? due : null;
}

export function markDone(store: Store, key: string): void {
  store.put("done", [...(store.get<string[]>("done") ?? []), key].slice(-KEEP_DONE));
}

/** Run the latest due event, once. Its key is recorded before acting, so a re-fire or a failure never replays it. */
export async function runDue(ctx: RunCtx): Promise<void> {
  const due = findDue(ctx.store, ctx.now);
  if (!due) return;
  markDone(ctx.store, due.key);

  const { ev, key } = due;
  const summary = eventSummary(ev);
  try {
    const d = await ctx.daikin();
    if (ev.kind === "resume") {
      const skip = await resumeSkipReason(d, ctx.now);
      if (skip) {
        log(ctx, ev.kind, summary, "skipped", skip);
        return;
      }
    }
    const expect: Control = ev.kind === "end" ? { power: 0 } : startCommand(ev.period);
    await send(ctx, d, { key, kind: ev.kind, summary, expect });
  } catch (e) {
    failed(ctx, ev.kind, summary, e);
  }
}

/** Send `expect` and set up its confirm check. Throws Daikin errors to the caller. */
export async function send(
  ctx: RunCtx,
  d: Daikin,
  x: Pick<Pending, "key" | "kind" | "summary" | "expect">,
): Promise<void> {
  await d.control(x.expect);
  const old = ctx.store.get<Pending>("pending");
  if (old && old.key !== x.key) log(ctx, old.kind, old.summary, "skipped", "replaced by a newer command");
  ctx.store.put("pending", { ...x, checkAtMs: checkAt(ctx), retried: false } satisfies Pending);
}

/** Read `/me`: done if it matches, else resend once, else failed. Clears `pending` when finished. */
export async function runConfirm(ctx: RunCtx, p: Pending): Promise<void> {
  try {
    const d = await ctx.daikin();
    const me = await d.me();
    // A newer command replaced this one while /me was in flight; it owns the check now (send() logged this one).
    if (ctx.store.get<Pending>("pending")?.key !== p.key) return;
    if (matches(me.aircon, p.expect)) {
      clearPending(ctx.store, p.key);
      log(ctx, p.kind, p.summary, "done");
      return;
    }
    if (!p.retried) {
      await d.control(p.expect);
      if (ctx.store.get<Pending>("pending")?.key === p.key) {
        ctx.store.put("pending", { ...p, retried: true, checkAtMs: checkAt(ctx) } satisfies Pending);
      }
      return;
    }
    clearPending(ctx.store, p.key);
    log(ctx, p.kind, p.summary, "failed", "the aircon didn't respond");
  } catch (e) {
    clearPending(ctx.store, p.key);
    failed(ctx, p.kind, p.summary, e);
  }
}

/** Every field we sent equals the aircon's value. */
function matches(aircon: Aircon | null, expect: Control): boolean {
  if (!aircon) return false;
  return (Object.keys(expect) as (keyof Control)[]).every((k) => aircon[k] === expect[k]);
}

/** Null when Daikin's 11:00 cut-off switched the aircon off today; otherwise why to leave it alone. */
async function resumeSkipReason(d: Daikin, now: number): Promise<string | null> {
  const me = await d.me();
  if (!me.aircon) throw new DaikinError(0, "no aircon is paired");
  if (me.aircon.power === 1) return "already on";
  const { rows } = await d.usage(1, 0);
  const end = rows[0]?.endtime;
  if (typeof end === "string" && cutAt1100(end, now)) return null;
  // Say what was seen, so lagging usage history can be told apart from a real switch-off.
  return `switched off before 11:00 (${lastSeen(rows.length > 0, end, now)})`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The latest usage row in a few words: its SGT end time (with the date when not today), or why there is none. */
function lastSeen(hasRow: boolean, end: unknown, now: number): string {
  if (!hasRow) return "no usage row yet";
  if (typeof end !== "string") return "last session not ended yet";
  const ms = STAMP.test(end) ? Date.parse(end) : NaN;
  if (!Number.isFinite(ms)) return "last session end unreadable";
  const local = new Date(ms + SGT_MS);
  const hhmm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const today = Math.floor((ms + SGT_MS) / DAY_MS) === Math.floor((now + SGT_MS) / DAY_MS);
  return `last session ended ${today ? "" : `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} `}${hhmm}`;
}

/** True when `stamp` falls in 11:00:00–11:00:59 SGT on the same SGT day as `now`. */
export function cutAt1100(stamp: string, now: number): boolean {
  if (!STAMP.test(stamp)) return false;
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return false;
  const local = ms + SGT_MS;
  const sameDay = Math.floor(local / DAY_MS) === Math.floor((now + SGT_MS) / DAY_MS);
  return sameDay && Math.floor((local % DAY_MS) / 60_000) === 11 * 60;
}

function clearPending(store: Store, key: string): void {
  if (store.get<Pending>("pending")?.key === key) store.del("pending");
}

function log(ctx: RunCtx, kind: Activity["kind"], summary: string, result: Activity["result"], reason?: string): void {
  ctx.store.log({ at: ctx.now, kind, summary, result, ...(reason ? { reason } : {}) });
}

/** Log a failed action. An expired login stops the schedule (the caller's re-arm then disarms). Never throws. */
function failed(ctx: RunCtx, kind: Activity["kind"], summary: string, e: unknown): void {
  if (e instanceof DaikinExpired) {
    ctx.store.put("expired", true);
    ctx.store.del("pending");
    log(ctx, kind, summary, "skipped", "signed out by Daikin");
  } else if (e instanceof DaikinError) {
    log(ctx, kind, summary, "failed", e.message);
  } else {
    console.error("schedule action failed:", e instanceof Error ? e.name : "unknown");
    log(ctx, kind, summary, "failed", "something went wrong");
  }
}
