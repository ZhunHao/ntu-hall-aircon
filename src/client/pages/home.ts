import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import "../lib/theme";
import "../styles/home.css";
import type { ConfigView, MeView, TopUpView } from "../../shared/api";
import type { Fan, Schedule } from "../../shared/schedule";
import { api, ApiError } from "../lib/api";
import { fanFromUi, safeHttpsUrl, safeQr, sgd } from "../lib/format";
import {
  actionText,
  ARC,
  balancePercent,
  clampSetpoint,
  type ControlBody,
  countdownText,
  dialPoint,
  disabledNote,
  fanUiValue,
  isLowBalance,
  matchesPending,
  mergePending,
  MODE_HINT,
  nextEventText,
  overlay,
  roomTempText,
  secondsLeft,
  tempAtPoint,
  unitState,
  type UnitState,
} from "../lib/home-logic";
import { ICONS, type IconKey } from "../lib/icons";
import { mountShell } from "../lib/shell";
import { toast } from "../lib/toast";

const NORMAL_POLL_MS = 10_000;
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_MAX_MS = 15_000;
const SETPOINT_DEBOUNCE_MS = 600;
const QR_LIFETIME_S = 15 * 60;
const CIRCUMFERENCE = 2 * Math.PI * 108;

// ---------- Markup ----------
const main = mountShell("home");

function fromTemplate(id: string): DocumentFragment {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return document.importNode(tpl.content, true);
}

/** Paints `<wa-icon data-i="key">` placeholders with the mdi icon for that key. */
function paintIcons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("wa-icon[data-i]").forEach((el) => {
    el.setAttribute("library", "mdi");
    el.setAttribute("name", ICONS[el.dataset.i as IconKey]);
  });
}

main.append(fromTemplate("home-main"));
document.body.append(fromTemplate("home-dialog"));
paintIcons(document);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Input = HTMLElement & { value: string; disabled: boolean; hint: string };
type Switch = HTMLElement & { checked: boolean; disabled: boolean };
type Button = HTMLElement & { disabled: boolean; loading: boolean; variant: string };
type Callout = HTMLElement & { variant: string };
type Dialog = HTMLElement & { open: boolean };

const thermo = $("thermo");
const dial = $("dial");
const dialSvg = document.getElementById("dial-svg") as unknown as SVGSVGElement;
const modeGroup = $<Input>("mode");
const fanGroup = $<Input>("fan");
const swing = $<Switch>("swing");
const powerBtn = $<Button>("power");
const minusBtn = $<Button>("minus");
const plusBtn = $<Button>("plus");
const dialog = $<Dialog>("dialog");
const methodGroup = $<Input>("method");
const amountGroup = $<Input>("amount");

// ---------- State ----------
let me: MeView | null = null;
let cfg: ConfigView | null = null;
let schedule: Schedule | null = null;
/** Changes sent and waiting for the unit to confirm. The page shows them laid over the unit's state. */
let pending: ControlBody | null = null;
/** A setpoint the resident is dragging or has stepped to, not yet sent. */
let localSp: number | null = null;

const range = (): { min: number; max: number } => ({ min: cfg?.tempMin ?? 22, max: cfg?.tempMax ?? 26 });

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "No connection. Check your internet and try again.";
    if (err.status === 502) return "Couldn't reach the aircon. Try again.";
    if (err.status === 400) return "That isn't allowed right now.";
  }
  return "Something went wrong. Try again.";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- Render ----------
function setTone(el: HTMLElement, tone: string): void {
  el.classList.remove("tone-ok", "tone-warn", "tone-bad", "tone-neutral", "tone-cool", "tone-brand");
  el.classList.add(tone);
}

function renderDial(setpoint: number, roomTemp: number | null): void {
  const { min, max } = range();
  const p = dialPoint(setpoint, min, max);
  $("track").setAttribute("stroke-dasharray", `${ARC.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`);
  $("arc").setAttribute("stroke-dasharray", `${(ARC * p.f).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`);
  $("knob").setAttribute("cx", String(p.x));
  $("knob").setAttribute("cy", String(p.y));
  // No reading (e.g. offline): hide the room-temperature marker.
  $("cur").setAttribute("visibility", roomTemp === null ? "hidden" : "visible");
  if (roomTemp !== null) {
    const cur = dialPoint(roomTemp, min, max);
    $("cur").setAttribute("cx", String(cur.x));
    $("cur").setAttribute("cy", String(cur.y));
  }
  $("sp").textContent = String(setpoint);
  dialSvg.setAttribute("aria-valuemin", String(min));
  dialSvg.setAttribute("aria-valuemax", String(max));
  dialSvg.setAttribute("aria-valuenow", String(setpoint));
  dialSvg.setAttribute("aria-valuetext", `${setpoint} °C`);
}

function renderCallout(st: UnitState, balance: number): void {
  const c = $<Callout>("callout");
  let msg: { variant: string; bold: string; rest: string; icon: IconKey } | null = null;
  if (st === "unpaired") {
    msg = { variant: "brand", bold: "No aircon paired yet.", rest: " Pair your room to start.", icon: "info" };
  } else if (st === "offline") {
    msg = { variant: "danger", bold: "Unit offline.", rest: " Your aircon isn't reporting. Billing stops while it's off.", icon: "alert" };
  } else if (st === "maintenance") {
    msg = { variant: "warning", bold: "Maintenance.", rest: " The hall is servicing aircons. Controls are paused.", icon: "alert" };
  } else if (isLowBalance(balance)) {
    msg = { variant: "warning", bold: "Low balance.", rest: ` ${sgd(balance)} left. The aircon switches off at S$0.`, icon: "alert" };
  }
  c.hidden = !msg;
  if (!msg) return;
  c.variant = msg.variant;
  $("callout-icon").setAttribute("name", ICONS[msg.icon]);
  const text = $("callout-text");
  const strong = document.createElement("strong");
  strong.textContent = msg.bold;
  text.replaceChildren(strong, msg.rest);
  if (st === "unpaired") {
    const link = document.createElement("a");
    link.href = "/settings";
    link.textContent = "Open Settings";
    text.append(" ", link);
  }
}

function render(): void {
  const loaded = me !== null;
  $("loading").hidden = loaded;
  $("home").hidden = !loaded;
  if (!me) return;

  const st = unitState(me.aircon);
  const aircon = me.aircon;
  const view = aircon ? overlay(aircon, pending ?? {}) : null;
  const blocked = st !== "online";

  // Badges and tiles
  const money = sgd(me.balance);
  const low = isLowBalance(me.balance);
  $("badge-balance").textContent = money;
  $("balance").textContent = money;
  $<HTMLElement & { value: number }>("balance-bar").value = balancePercent(me.balance);
  setTone($("badge-wallet"), low ? "tone-warn" : "tone-ok");
  setTone($("tile-balance"), low ? "tone-warn" : "tone-ok");

  const room = roomTempText(aircon);
  $("badge-temp").textContent = room;
  $("room-temp").textContent = room;
  $("tile-room-text").textContent = room;
  setTone($("badge-room"), "tone-neutral");
  setTone($("tile-room"), "tone-cool");

  const unitText = { unpaired: "Not paired", offline: "Offline", maintenance: "Maintenance", online: "Online" }[st];
  $("unit-text").textContent = unitText;
  $("unit-icon").setAttribute("name", ICONS[st === "offline" ? "wifioff" : st === "maintenance" ? "tool" : "wifi"]);
  setTone($("badge-unit"), st === "online" ? "tone-ok" : st === "offline" ? "tone-bad" : "tone-warn");

  setTone($("tile-off"), "tone-neutral");
  setTone($("tile-schedule"), "tone-brand");
  $("schedule-text").textContent = nextEventText(schedule, Date.now());

  renderCallout(st, me.balance);

  // Thermostat
  $("aircon-section").hidden = !aircon;
  if (!aircon || !view) return;
  const setpoint = localSp ?? view.setpoint;
  renderDial(setpoint, aircon.current_temperature);
  const waiting = pending !== null;
  thermo.dataset.mode = view.mode;
  thermo.dataset.power = view.power ? "on" : "off";
  thermo.dataset.state = st;
  dial.classList.toggle("pending", waiting);
  $("spin").hidden = !waiting;
  $("action-text").textContent = actionText(st, view.power, view.mode, waiting);

  for (const el of [minusBtn, plusBtn, powerBtn, modeGroup, fanGroup, swing]) el.disabled = blocked;
  dialSvg.setAttribute("aria-disabled", String(blocked));
  const note = $("disabled-note");
  note.hidden = !blocked;
  note.textContent = disabledNote(st);

  powerBtn.variant = view.power ? "danger" : "brand";
  $("power-text").textContent = view.power ? "Turn off" : "Turn on";
  modeGroup.value = view.mode;
  modeGroup.hint = MODE_HINT[view.mode];
  fanGroup.value = fanUiValue(view.fanstep);
  swing.checked = view.flap === "S";
}

// ---------- Loading /api/me ----------
let inflight: Promise<void> | null = null;

/** One load of `/api/me` at a time: a second caller waits for the one already running. */
function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      me = await api<MeView>("GET", "/api/me");
      $("load-error").hidden = true;
      checkTopUpPaid();
    } catch (err) {
      // api() already sends a 401 to sign-in. Anything else: keep what is on screen and try again later.
      if (!(err instanceof ApiError && err.status === 401) && !me) $("load-error").hidden = false;
    } finally {
      inflight = null;
    }
    render();
  })();
  return inflight;
}

async function loadConfig(): Promise<void> {
  if (cfg) return;
  try {
    cfg = await api<ConfigView>("GET", "/api/config");
    render();
  } catch {
    // The dial keeps its 22 to 26 default; the top-up dialog asks again when opened.
  }
}

async function loadSchedule(): Promise<void> {
  try {
    schedule = await api<Schedule>("GET", "/api/schedule");
    render();
  } catch {
    // The schedule tile keeps its last text.
  }
}

// ---------- Controls: send, show pending, poll until the unit shows it ----------
let confirming = false;
let confirmDeadline = 0;

/** Polls every 2 s, up to 15 s from the latest change, until `/api/me` shows everything that was sent. */
async function confirmPending(): Promise<void> {
  confirmDeadline = Date.now() + CONFIRM_MAX_MS;
  if (confirming) return; // the running loop picks up the new deadline
  confirming = true;
  try {
    while (pending) {
      await sleep(CONFIRM_POLL_MS);
      await refresh();
      if (!pending) return;
      if (me?.aircon && matchesPending(me.aircon, pending)) {
        pending = null;
        render();
        toast("Done", "success");
        return;
      }
      if (Date.now() >= confirmDeadline) {
        pending = null;
        render();
        toast("The aircon didn't respond. Try again.", "danger");
        return;
      }
    }
  } finally {
    confirming = false;
  }
}

async function sendControl(change: ControlBody): Promise<void> {
  pending = mergePending(pending ?? {}, change);
  render();
  try {
    await api("POST", "/api/control", change);
  } catch (err) {
    // Drop just the fields that failed; an earlier change may still be waiting.
    if (pending) {
      for (const k of Object.keys(change) as (keyof ControlBody)[]) delete pending[k];
      if (Object.keys(pending).length === 0) pending = null;
    }
    render();
    if (!(err instanceof ApiError && err.status === 401)) toast(errorText(err), "danger");
    return;
  }
  void confirmPending();
}

// Setpoint: the dial and the buttons change a local value at once; one control goes out when the resident stops.
let spTimer: ReturnType<typeof setTimeout> | undefined;

function commitSetpoint(): void {
  clearTimeout(spTimer);
  const sp = localSp;
  if (sp === null) return;
  localSp = null;
  const current = me?.aircon ? overlay(me.aircon, pending ?? {}).setpoint : sp;
  if (sp === current) {
    render();
    return;
  }
  void sendControl({ setpoint: sp });
}

function nudgeSetpoint(to: number): void {
  const { min, max } = range();
  localSp = clampSetpoint(to, min, max);
  render();
  clearTimeout(spTimer);
  spTimer = setTimeout(commitSetpoint, SETPOINT_DEBOUNCE_MS);
}

const shownSetpoint = (): number => localSp ?? (me?.aircon ? overlay(me.aircon, pending ?? {}).setpoint : 24);

minusBtn.addEventListener("click", () => nudgeSetpoint(shownSetpoint() - 1));
plusBtn.addEventListener("click", () => nudgeSetpoint(shownSetpoint() + 1));

let dragging = false;
const isBlocked = (): boolean => dialSvg.getAttribute("aria-disabled") === "true";

function fromPointer(e: PointerEvent): number {
  const r = dialSvg.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 260;
  const y = ((e.clientY - r.top) / r.height) * 260;
  const { min, max } = range();
  return tempAtPoint(x, y, min, max);
}

dialSvg.addEventListener("pointerdown", (e) => {
  if (isBlocked()) return;
  dragging = true;
  dialSvg.setPointerCapture(e.pointerId);
  dial.classList.add("dragging");
  clearTimeout(spTimer);
  const { min, max } = range();
  localSp = clampSetpoint(fromPointer(e), min, max);
  render();
});
dialSvg.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const { min, max } = range();
  const next = clampSetpoint(fromPointer(e), min, max);
  if (next !== localSp) {
    localSp = next;
    render();
  }
});
const endDrag = (): void => {
  if (!dragging) return;
  dragging = false;
  dial.classList.remove("dragging");
  commitSetpoint(); // only the release sends
};
dialSvg.addEventListener("pointerup", endDrag);
dialSvg.addEventListener("pointercancel", endDrag);

dialSvg.addEventListener("keydown", (e) => {
  if (isBlocked()) return;
  const { min, max } = range();
  const step = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[e.key];
  if (step) {
    e.preventDefault();
    nudgeSetpoint(shownSetpoint() + step);
  } else if (e.key === "Home") {
    e.preventDefault();
    nudgeSetpoint(min);
  } else if (e.key === "End") {
    e.preventDefault();
    nudgeSetpoint(max);
  }
});

modeGroup.addEventListener("change", () => {
  const mode = modeGroup.value as ControlBody["mode"];
  if (mode) void sendControl({ mode });
});
fanGroup.addEventListener("change", () => {
  const v = fanGroup.value as "A" | "1" | "2" | "3" | "4" | "5";
  const fanstep: Fan = fanFromUi(v);
  void sendControl({ fanstep });
});
swing.addEventListener("change", () => void sendControl({ flap: swing.checked ? "S" : "N" }));
powerBtn.addEventListener("click", () => {
  const on = me?.aircon ? overlay(me.aircon, pending ?? {}).power : 0;
  void sendControl({ power: on ? 0 : 1 });
});

// ---------- Top-up ----------
let qrTimer: ReturnType<typeof setInterval> | undefined;
/** Set while a payment is waiting: the balance when it started. A higher balance means it was paid. */
let paidBaseline: number | null = null;

function showPayError(text: string): void {
  $("pay-error-text").textContent = text;
  $("pay-error").hidden = false;
}

/** Back to the start of the dialog: no QR, no countdown, no link, nothing waiting. */
function resetTopUp(): void {
  clearInterval(qrTimer);
  paidBaseline = null;
  $("qr-box").hidden = true;
  ($("qr") as HTMLImageElement).removeAttribute("src");
  $("show-qr").hidden = false;
  $("show-qr-text").textContent = "Show PayNow QR";
  $("enets-link").hidden = true;
  $("pay-error").hidden = true;
  $<Button>("show-qr").loading = false;
  $<Button>("enets").loading = false;
}

function fillAmounts(): void {
  const amounts = cfg?.amounts ?? [];
  const radios = amounts.map((a) => {
    const r = document.createElement("wa-radio");
    r.setAttribute("appearance", "button");
    r.setAttribute("value", String(a));
    r.textContent = `S$${a}`;
    return r;
  });
  amountGroup.replaceChildren(...radios);
  amountGroup.value = String(amounts[0] ?? "");
}

async function openTopUp(): Promise<void> {
  await loadConfig();
  if (!cfg || cfg.amounts.length === 0) {
    toast("Couldn't load the top-up amounts. Try again.", "danger");
    return;
  }
  resetTopUp();
  fillAmounts();
  methodGroup.value = "paynow";
  $("pay-paynow").hidden = false;
  $("pay-card").hidden = true;
  dialog.open = true;
}

const chosenAmount = (): number => Number(amountGroup.value);

/** Called after each `/api/me`: closes the dialog when the balance rose while a payment was waiting. */
function checkTopUpPaid(): void {
  if (paidBaseline === null || !me || me.balance <= paidBaseline) return;
  const added = me.balance - paidBaseline;
  resetTopUp();
  dialog.open = false;
  toast(`Top-up received: +${sgd(added)}`, "success", 4500);
}

function startCountdown(): void {
  const deadline = Date.now() + QR_LIFETIME_S * 1000;
  clearInterval(qrTimer);
  const tick = (): void => {
    const left = secondsLeft(deadline, Date.now());
    $("countdown").textContent = countdownText(left);
    if (left > 0) return;
    clearInterval(qrTimer);
    paidBaseline = null;
    $("qr-spin").hidden = true;
    $("qr-status").textContent = "This QR has expired.";
    $("show-qr").hidden = false;
    $("show-qr-text").textContent = "Show a new QR";
  };
  $("qr-spin").hidden = false;
  $("qr-status").textContent = "Waiting for payment";
  tick();
  qrTimer = setInterval(tick, 1000);
}

$("show-qr").addEventListener("click", async () => {
  const btn = $<Button>("show-qr");
  resetTopUp();
  btn.loading = true;
  try {
    const res = await api<TopUpView>("POST", "/api/topup", { amount: chosenAmount(), type: "PayNow" });
    const src = safeQr(res?.qrcode);
    if (!src) {
      showPayError("Couldn't show the QR code. Try again.");
      return;
    }
    ($("qr") as HTMLImageElement).src = src;
    $("qr-box").hidden = false;
    btn.hidden = true;
    paidBaseline = me?.balance ?? 0;
    startCountdown();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) showPayError("Couldn't create the PayNow QR. Try again.");
  } finally {
    btn.loading = false;
  }
});

$("enets").addEventListener("click", async () => {
  const btn = $<Button>("enets");
  $("pay-error").hidden = true;
  btn.loading = true;
  try {
    const res = await api<TopUpView>("POST", "/api/topup", { amount: chosenAmount(), type: "VisaMaster" });
    const url = safeHttpsUrl(res?.payment_url);
    if (!url) {
      showPayError("Couldn't open the card payment page. Try again.");
      return;
    }
    paidBaseline = me?.balance ?? 0;
    window.open(url, "_blank", "noopener,noreferrer");
    // Some browsers block a tab opened after a request; the link is there for that.
    const link = $<HTMLAnchorElement>("enets-link");
    link.href = url;
    link.hidden = false;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) showPayError("Couldn't start the card payment. Try again.");
  } finally {
    btn.loading = false;
  }
});

methodGroup.addEventListener("change", () => {
  const card = methodGroup.value === "card";
  resetTopUp();
  $("pay-paynow").hidden = card;
  $("pay-card").hidden = !card;
});
amountGroup.addEventListener("change", resetTopUp);
dialog.addEventListener("wa-after-hide", (e) => {
  if (e.target === dialog) resetTopUp();
});
$("topup").addEventListener("click", () => void openTopUp());
$("badge-wallet").addEventListener("click", () => void openTopUp());

// ---------- Polling ----------
setInterval(() => {
  // Not while hidden, and not while a change is being confirmed (that loop polls faster).
  if (document.visibilityState === "visible" && !confirming) void refresh();
}, NORMAL_POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void refresh();
  void loadSchedule();
});

render();
void refresh();
void loadConfig();
void loadSchedule();
