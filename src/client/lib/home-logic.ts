// Pure logic for the Home page: kept out of home.ts so it can be unit tested without a browser.
import type { AirconView } from "../../shared/api";
import { eventSummary, nextEventAfter } from "../../shared/events";
import type { Fan, Mode, Schedule } from "../../shared/schedule";
import { fanLabel } from "./format";

/** The fields `POST /api/control` accepts. Only the changed ones are sent. */
export interface ControlBody {
  power?: 0 | 1;
  setpoint?: number;
  mode?: Mode;
  fanstep?: Fan;
  flap?: "N" | "S";
}

const CONTROL_KEYS = ["power", "setpoint", "mode", "fanstep", "flap"] as const;

/** True when every field the resident sent shows in what `/api/me` reports. */
export function matchesPending(aircon: AirconView, sent: ControlBody): boolean {
  return CONTROL_KEYS.every((k) => sent[k] === undefined || aircon[k] === sent[k]);
}

/** A newer change wins field by field over an older one that is still waiting. */
export function mergePending(older: ControlBody, newer: ControlBody): ControlBody {
  return { ...older, ...newer };
}

/** What the page shows while a change is waiting: the unit's state with the sent fields laid over it. */
export function overlay(aircon: AirconView, pending: ControlBody): AirconView {
  return { ...aircon, ...pending };
}

/** The room temperature, or "—" when there is no aircon or it sent no reading (e.g. offline). */
export function roomTempText(aircon: AirconView | null): string {
  const t = aircon?.current_temperature;
  return typeof t === "number" ? `${t.toFixed(1)} °C` : "—";
}

export type UnitState = "unpaired" | "offline" | "maintenance" | "online";

/** Not paired wins, then offline (`comm_stat !== 1`), then maintenance. Controls work only when online. */
export function unitState(aircon: AirconView | null): UnitState {
  if (!aircon) return "unpaired";
  if (aircon.comm_stat !== 1) return "offline";
  if (aircon.maintenance_mode) return "maintenance";
  return "online";
}

/** The balance below which the page warns, in dollars. */
export const LOW_BALANCE = 3;

export function isLowBalance(balance: number): boolean {
  return balance < LOW_BALANCE;
}

/** The balance bar is out of Daikin's S$50 cap. Result is 0..100. */
export function balancePercent(balance: number): number {
  return Math.min(100, Math.max(0, (balance / 50) * 100));
}

/** The value of the fan button for a Daikin fan step: "A", then "1" to "5". */
export function fanUiValue(f: Fan): "A" | "1" | "2" | "3" | "4" | "5" {
  return f === "A" ? "A" : (fanLabel(f) as "1" | "2" | "3" | "4" | "5");
}

export const MODE_ACTION: Record<Mode, string> = { C: "Cooling", F: "Fan only", A: "Auto", D: "Dehumidifying" };
export const MODE_NAME: Record<Mode, string> = { C: "cool", F: "fan", A: "auto", D: "dehumidify" };
export const MODE_HINT: Record<Mode, string> = {
  C: "Cools the room to the setpoint.",
  F: "Moves air without cooling. Cheapest on mild nights.",
  A: "The unit picks cooling or fan on its own.",
  D: "Removes moisture from the air with light cooling. Good for muggy, rainy days.",
};

/** The line in the middle of the dial. */
export function actionText(state: UnitState, power: 0 | 1, mode: Mode, pending: boolean): string {
  if (state === "offline") return "Unavailable";
  if (state === "maintenance") return "Maintenance";
  if (pending) return "Sending…";
  return power ? MODE_ACTION[mode] : "Off";
}

/** The note under the controls when they are disabled. Empty when they work. */
export function disabledNote(state: UnitState): string {
  if (state === "offline") return "The unit isn't reporting. Controls come back when it reconnects.";
  if (state === "maintenance") return "Hall maintenance is on. Controls are paused.";
  return "";
}

/** "15:00". Negative input counts as zero. */
export function countdownText(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Whole seconds from `nowMs` to `deadlineMs`, never below zero. */
export function secondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SGT_OFFSET = 8 * 3_600_000;

/** "Mon 23:00", the Singapore day and time of `ms`. */
export function sgtStamp(ms: number): string {
  const d = new Date(ms + SGT_OFFSET);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[(d.getUTCDay() + 6) % 7]} ${hh}:${mm}`;
}

/** The schedule tile's text: when the next event runs and what it does. */
export function nextEventText(schedule: Schedule | null, nowMs: number): string {
  if (!schedule || !schedule.enabled) return "Schedule is off";
  const next = nextEventAfter(schedule.periods, nowMs);
  if (!next) return "No schedule yet";
  return `Next: ${sgtStamp(next.atMs)} · ${eventSummary(next.ev)}`;
}

// ---------- Dial geometry (a 260 x 260 viewBox, 270 degrees from the lower left round to the lower right) ----------
export const DIAL = { cx: 130, cy: 130, r: 108, sweep: 270, start: 135 };
/** Arc length of the sweep: r * 270 degrees in radians. */
export const ARC = DIAL.r * ((DIAL.sweep * Math.PI) / 180);

/** Where a temperature sits on the dial: its fraction of the arc and its x, y in the viewBox. */
export function dialPoint(temp: number, min: number, max: number): { f: number; x: number; y: number } {
  const f = max > min ? (Math.min(max, Math.max(min, temp)) - min) / (max - min) : 0;
  const a = ((DIAL.start + DIAL.sweep * f) * Math.PI) / 180;
  return { f, x: DIAL.cx + DIAL.r * Math.cos(a), y: DIAL.cy + DIAL.r * Math.sin(a) };
}

/** The (fractional) temperature under a point in viewBox units. The gap at the bottom snaps to the nearer end. */
export function tempAtPoint(x: number, y: number, min: number, max: number): number {
  let deg = (Math.atan2(y - DIAL.cy, x - DIAL.cx) * 180) / Math.PI - DIAL.start;
  deg = ((deg % 360) + 360) % 360;
  if (deg > DIAL.sweep) deg = deg > DIAL.sweep + (360 - DIAL.sweep) / 2 ? 0 : DIAL.sweep;
  return min + (deg / DIAL.sweep) * (max - min);
}

/** A whole-degree setpoint inside the range. */
export function clampSetpoint(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}
