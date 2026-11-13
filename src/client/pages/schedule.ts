import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/number-input/number-input.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import "../lib/theme";
import "../lib/time-wheel";
import "../styles/schedule.css";
import type { Activity } from "../../shared/api";
import { groupOf, type Mode, type Period, type Schedule, type View } from "../../shared/schedule";
import { api, ApiError } from "../lib/api";
import { fanFromUi } from "../lib/format";
import { fanUiValue } from "../lib/home-logic";
import { ICONS, type IconKey } from "../lib/icons";
import {
  activityLine,
  activityTime,
  bars,
  carryOver,
  carryText,
  costText,
  crossesCut,
  CUT_NOTE,
  cutMark,
  DAYS,
  defaultDraft,
  type Draft,
  draftCrossesCut,
  editBlock,
  group,
  linkedTo,
  offersApplyNow,
  periodTag,
  periodWhat,
  planCopy,
  planDelete,
  planEdit,
  problemText,
  type QuickKey,
  repeatWindows,
  repeatsText,
  runsText,
  statusText,
  tabLabel,
  tabSummary,
  VIEWS,
  windowAt,
  windowSub,
  windowTitle,
} from "../lib/schedule-logic";
import { mountShell } from "../lib/shell";
import { toast } from "../lib/toast";

const ACTIVITY_LIMIT = 30;
const RETRY_MS = 5_000;
const APPLY_TOAST_MS = 12_000;
const CONFIRM_REFRESH_MS = 15_000;
const MODE_ICON: Record<Mode, IconKey> = { C: "cool", D: "dry", F: "fan", A: "auto" };

// ---------- Markup ----------
const main = mountShell("schedule");

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

main.append(fromTemplate("schedule-main"));
document.body.append(fromTemplate("schedule-dialogs"));
paintIcons(document);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Input = HTMLElement & { value: string | null; disabled: boolean };
type Switch = HTMLElement & { checked: boolean; disabled: boolean };
type Button = HTMLElement & { disabled: boolean; loading: boolean };
type Dialog = HTMLElement & { open: boolean; label: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconEl(key: IconKey, cls?: string): HTMLElement {
  const i = el("wa-icon", cls);
  i.setAttribute("library", "mdi");
  i.setAttribute("name", ICONS[key]);
  return i;
}

// ---------- State ----------
let schedule: Schedule | null = null;
/** The night or day being shown, 0 = Monday. */
let sel = 0;
let activity: Activity[] = [];

const view = (): View => schedule?.view ?? "nights";

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 0) return "No connection. Check your internet and try again.";
  return "Couldn't save the schedule. Try again.";
}

// ---------- Render ----------
/** Fills a track (the selected window's bar or a week row) with its 11:00 mark and period bars. */
function drawTrack(track: HTMLElement, n: number, periods: Period[]): void {
  const mark = el("span", "mark");
  mark.style.left = `${cutMark(view())}%`;
  const items: HTMLElement[] = [mark];
  for (const b of bars(periods, n, view())) {
    const i = el("i", `m-${b.mode}${b.spill ? " spill" : ""}`);
    i.style.left = `${b.left}%`;
    i.style.width = `${b.width}%`;
    items.push(i);
  }
  track.replaceChildren(...items);
}

function renderTabs(periods: Period[]): void {
  const v = VIEWS[view()];
  const tabs = $("nights");
  tabs.setAttribute("aria-label", v.nouns[0].toUpperCase() + v.nouns.slice(1));
  tabs.replaceChildren(
    ...DAYS.map((d, n) => {
      const list = group(periods, n, view());
      const s = tabSummary(list);
      const b = el("button", "night");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.night = String(n);
      b.setAttribute("aria-selected", String(n === sel));
      b.setAttribute("aria-label", tabLabel(view(), n, list));
      const t = el("span", s.off ? "t off" : "t");
      t.append(...s.parts.map((part) => el("span", undefined, part)));
      b.append(el("span", undefined, d), t);
      return b;
    }),
  );
}

function periodRow(p: Period, periods: Period[]): HTMLElement {
  const row = el("button", "period");
  row.type = "button";
  row.dataset.idx = String(periods.indexOf(p));
  const when = el("span", "when", `${p.start} → ${p.end}`);
  when.append(el("small", undefined, periodTag(view(), p)));
  const ico = el("span", `ico m-${p.mode}`);
  ico.append(iconEl(MODE_ICON[p.mode]));
  const what = el("span", "what");
  what.append(el("span", undefined, periodWhat(p)));
  const rep = repeatsText(periods, p, view());
  if (rep) what.append(el("span", "rep", rep));
  if (crossesCut(p)) what.append(el("span", "note", CUT_NOTE));
  row.append(when, ico, what, iconEl("edit", "edit"));
  row.setAttribute("aria-label", `${p.start} to ${p.end}, ${periodWhat(p)}. Edit`);
  return row;
}

function renderWindow(periods: Period[]): void {
  const v = view();
  const list = group(periods, sel, v);
  $("night-title").textContent = windowTitle(v, sel);
  $("night-sub").textContent = windowSub(v, sel);
  drawTrack($("mini"), sel, periods);
  $("copy-label").textContent = `Copy ${windowTitle(v, sel)} to…`;
  $<Button>("copy").disabled = !list.length;
  $("clear").hidden = !list.length;

  const rows: HTMLElement[] = carryOver(periods, sel, v).map((p) => {
    const b = el("button", "carry", carryText(v, sel, p));
    b.type = "button";
    b.dataset.night = String((sel + 6) % 7);
    return b;
  });
  if (!list.length) {
    const empty = el("div", "empty-night");
    empty.append(el("span", "muted", `Nothing starts on ${windowTitle(v, sel)} yet.`));
    rows.push(empty);
  }
  rows.push(...list.map((p) => periodRow(p, periods)));
  $("periods").replaceChildren(...rows);
}

function renderWeek(periods: Period[]): void {
  $("week").replaceChildren(
    ...DAYS.map((d, n) => {
      const row = el("button", n === sel ? "wk-row sel" : "wk-row");
      row.type = "button";
      row.dataset.night = String(n);
      row.setAttribute("aria-label", tabLabel(view(), n, group(periods, n, view())));
      const track = el("div", "track");
      drawTrack(track, n, periods);
      row.append(el("span", "d", d), track);
      return row;
    }),
  );
}

function renderStatus(): void {
  if (!schedule) return;
  const st = statusText(schedule, Date.now());
  $("status").classList.toggle("paused", !st.on);
  $("status-title").textContent = st.title;
  $("next").textContent = st.line;
  $("status-icon").setAttribute("name", ICONS[st.on ? "schedule" : "pause"]);
  $<Switch>("enabled").checked = schedule.enabled;
  $("cost").textContent = costText(schedule.periods);
}

function render(): void {
  $("loading").hidden = schedule !== null;
  $("sched").hidden = schedule === null;
  if (!schedule) return;
  const v = VIEWS[view()];
  const periods = schedule.periods;
  document.querySelectorAll<HTMLElement>("[data-axis]").forEach((a) => {
    a.replaceChildren(...v.axis.map((t) => el("span", undefined, t)));
  });
  $("explain").textContent = v.explain;
  $<Input>("view").value = view();
  renderStatus();
  renderTabs(periods);
  renderWindow(periods);
  renderWeek(periods);
}

function renderActivity(): void {
  const list = $("activity");
  $("activity-empty").hidden = activity.length > 0;
  list.replaceChildren(
    ...activity.map((a) => {
      const line = activityLine(a);
      const li = el("li");
      const res = el("span", `res res-${a.result}`, line.label);
      // `reason` may echo Daikin's text: textContent only.
      li.append(el("span", "when", activityTime(a.at)), res, el("span", "what", line.text));
      if (line.reason) li.append(el("span", "why", line.reason));
      return li;
    }),
  );
}

// ---------- Loading ----------
async function loadSchedule(): Promise<void> {
  try {
    const first = schedule === null;
    schedule = await api<Schedule>("GET", "/api/schedule");
    if (first) sel = windowAt(Date.now(), schedule.view);
    $("load-error").hidden = true;
    render();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (!schedule) {
      $("load-error").hidden = false;
      $("loading").hidden = true;
      setTimeout(() => void loadSchedule(), RETRY_MS);
    }
  }
}

async function loadActivity(): Promise<void> {
  try {
    activity = await api<Activity[]>("GET", `/api/activity?limit=${ACTIVITY_LIMIT}`);
    renderActivity();
  } catch {
    // The card keeps what it shows.
  }
}

// ---------- Saving: every change PUTs the whole schedule ----------
async function applyNow(): Promise<void> {
  try {
    const r = await api<{ applied: boolean }>("POST", "/api/schedule/apply-now");
    if (r?.applied) toast("Sent. The aircon is switching on.", "success");
    else toast("No period covers now, so nothing was sent.");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast("Couldn't reach the aircon. Try again.", "danger");
  }
  void loadActivity();
  // The server checks the aircon about 10 s after sending; show that result too.
  setTimeout(() => void loadActivity(), CONFIRM_REFRESH_MS);
}

/**
 * Sends `next` as the whole schedule. On success it becomes the page's schedule; on a 400 the first problem
 * goes to `showError` (the open dialog's message area) in the dialog's words. Returns whether it saved.
 */
async function save(next: Schedule, showError: (text: string) => void): Promise<boolean> {
  const before = schedule;
  if (!before) return false;
  try {
    await api("PUT", "/api/schedule", next);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    showError(err instanceof ApiError && err.status === 400 ? problemText(err.problems?.[0], next.periods, next.view) : errorText(err));
    return false;
  }
  schedule = next;
  render();
  if (offersApplyNow(before, next, Date.now())) {
    toast("Saved. A period you changed covers now.", "neutral", APPLY_TOAST_MS, { label: "Apply now", run: () => void applyNow() });
  }
  return true;
}

const toastError = (text: string): void => toast(text, "danger");

// ---------- Period editor ----------
// One dialog adds or edits a period on several nights or days at once ("Repeats on"). Each window keeps its own
// copy, so changing one later stays easy.
const dlg = $<Dialog>("dlg");
const fStart = $<Input>("f-start");
const fEnd = $<Input>("f-end");
const fSp = $<Input>("f-sp");
const fMode = $<Input>("f-mode");
const fFan = $<Input>("f-fan");
const fSave = $<Button>("f-save");
const fDelete = $<Button>("f-delete");

/** The period being edited and its identical copies; empty when adding. */
let linked: Period[] = [];
/** The windows the dialog applies to. */
let repeat: number[] = [];

function form(): Draft {
  const sp = Math.round(Number(fSp.value));
  return {
    start: (fStart.value ?? "").slice(0, 5),
    end: (fEnd.value ?? "").slice(0, 5),
    setpoint: Math.min(26, Math.max(22, Number.isFinite(sp) && sp > 0 ? sp : 24)),
    mode: (fMode.value ?? "C") as Mode,
    fan: fanFromUi((fFan.value ?? "A") as "A" | "1" | "2" | "3" | "4" | "5"),
  };
}

function showClash(id: "f" | "c", text: string | null): void {
  $(`${id}-clash`).hidden = !text;
  $(`${id}-clash-text`).textContent = text ?? "";
}

function check(): void {
  if (!schedule) return;
  const v = view();
  const nouns = VIEWS[v].nouns;
  const d = form();
  $("f-runs").textContent = runsText(d, v);
  $("f-past11").hidden = !draftCrossesCut(d, sel, v);
  $("f-days").replaceChildren(
    ...DAYS.map((x, n) => {
      const b = el("button", undefined, x.slice(0, 2));
      b.type = "button";
      b.dataset.r = String(n);
      b.setAttribute("aria-pressed", String(repeat.includes(n)));
      b.setAttribute("aria-label", windowTitle(v, n));
      return b;
    }),
  );
  const block = editBlock(schedule.periods, linked, repeat, d, v);
  showClash("f", block);
  fSave.disabled = !!block;
  fSave.textContent = repeat.length > 1 ? `Save to ${repeat.length} ${nouns}` : "Save";
  $("f-delete-text").textContent = repeat.length > 1 ? `Delete from ${repeat.length} ${nouns}` : "Delete";
  fDelete.disabled = !repeat.length;
}

function openPeriod(idx: number): void {
  if (!schedule) return;
  const editing = idx >= 0 ? schedule.periods[idx] : undefined;
  linked = editing ? linkedTo(schedule.periods, editing) : [];
  repeat = editing ? repeatWindows(schedule.periods, editing, view()) : [sel];
  const d: Draft = editing ?? defaultDraft(group(schedule.periods, sel, view()));
  dlg.label = editing ? "Edit period" : "Add a period";
  fStart.value = d.start;
  fEnd.value = d.end;
  fSp.value = String(d.setpoint);
  fMode.value = d.mode;
  fFan.value = fanUiValue(d.fan);
  fDelete.hidden = !editing;
  fSave.loading = false;
  dlg.open = true;
  requestAnimationFrame(check);
}

for (const f of [fStart, fEnd, fSp, fMode, fFan]) {
  f.addEventListener("input", check);
  f.addEventListener("change", check);
}
$("f-days").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
  if (!b) return;
  const n = Number(b.dataset.r);
  repeat = repeat.includes(n) ? repeat.filter((x) => x !== n) : [...repeat, n];
  check();
});

fSave.addEventListener("click", async () => {
  if (!schedule || fSave.disabled) return;
  const d = form();
  if (editBlock(schedule.periods, linked, repeat, d, view())) return;
  const r = planEdit(schedule.periods, linked, repeat, d, view());
  fSave.loading = true;
  const ok = await save({ ...schedule, periods: r.next }, (t) => showClash("f", t));
  fSave.loading = false;
  if (ok) dlg.open = false;
});

fDelete.addEventListener("click", async () => {
  if (!schedule || !repeat.length) return;
  fDelete.loading = true;
  const ok = await save({ ...schedule, periods: planDelete(schedule.periods, linked, repeat, view()) }, (t) => showClash("f", t));
  fDelete.loading = false;
  if (ok) dlg.open = false;
});

// ---------- Copy a night or day ----------
const copyDlg = $<Dialog>("copy-dlg");
const cSave = $<Button>("c-save");
let targets: number[] = [];

function drawPick(): void {
  if (!schedule) return;
  const v = view();
  $("c-pick").replaceChildren(
    ...DAYS.map((d, n) => {
      const b = el("button", undefined, d.slice(0, 2));
      b.type = "button";
      b.dataset.t = String(n);
      b.disabled = n === sel;
      b.setAttribute("aria-pressed", String(targets.includes(n)));
      b.setAttribute("aria-label", windowTitle(v, n));
      return b;
    }),
  );
  const r = planCopy(schedule.periods, sel, targets, v);
  showClash("c", r.text || null);
  cSave.disabled = !targets.length || !!r.clash;
  const nouns = VIEWS[v];
  cSave.textContent = targets.length ? `Copy to ${targets.length} ${targets.length > 1 ? nouns.nouns : nouns.noun}` : "Copy";
}

$("copy").addEventListener("click", () => {
  if (!schedule) return;
  const v = view();
  targets = [];
  copyDlg.label = `Copy ${windowTitle(v, sel)} to…`;
  $("c-note").textContent = `The ${VIEWS[v].nouns} you pick get exactly the same periods. Their current periods are replaced.`;
  document.querySelectorAll<HTMLElement>("[data-quick]").forEach((b) => {
    b.textContent = VIEWS[v].quick[b.dataset.quick as QuickKey].label;
  });
  cSave.loading = false;
  drawPick();
  copyDlg.open = true;
});
$("c-pick").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-t]");
  if (!b || b.disabled) return;
  const n = Number(b.dataset.t);
  targets = targets.includes(n) ? targets.filter((x) => x !== n) : [...targets, n];
  drawPick();
});
document.querySelectorAll<HTMLElement>("[data-quick]").forEach((b) =>
  b.addEventListener("click", () => {
    targets = VIEWS[view()].quick[b.dataset.quick as QuickKey].windows.filter((n) => n !== sel);
    drawPick();
  }),
);
cSave.addEventListener("click", async () => {
  if (!schedule || cSave.disabled) return;
  const r = planCopy(schedule.periods, sel, targets, view());
  if (r.clash) return;
  const from = windowTitle(view(), sel);
  const to = [...targets].sort((a, b) => a - b).map((n) => DAYS[n]).join(", ");
  cSave.loading = true;
  const ok = await save({ ...schedule, periods: r.next }, (t) => showClash("c", t));
  cSave.loading = false;
  if (!ok) return;
  copyDlg.open = false;
  toast(`Copied ${from} to ${to}`, "success");
});

// ---------- Other interactions ----------
main.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const win = t.closest<HTMLElement>("[data-night]");
  if (win) {
    sel = Number(win.dataset.night);
    render();
    return;
  }
  const row = t.closest<HTMLElement>(".period");
  if (row) openPeriod(Number(row.dataset.idx));
});
$("add").addEventListener("click", () => openPeriod(-1));

$("clear").addEventListener("click", async () => {
  if (!schedule) return;
  const v = view();
  const name = windowTitle(v, sel);
  const periods = schedule.periods.filter((p) => groupOf(p, v) !== sel);
  if (await save({ ...schedule, periods }, toastError)) toast(`Cleared ${name}`);
});

const enabled = $<Switch>("enabled");
enabled.addEventListener("change", async () => {
  if (!schedule) return;
  const on = enabled.checked;
  enabled.disabled = true;
  const ok = await save({ ...schedule, enabled: on }, toastError);
  enabled.disabled = false;
  if (ok) toast(on ? "Schedule resumed" : "Schedule paused", on ? "success" : "warning");
  else renderStatus(); // puts the switch back
});

const viewGroup = $<Input>("view");
viewGroup.addEventListener("change", async () => {
  if (!schedule) return;
  const next = viewGroup.value as View;
  if (next === schedule.view) return;
  const ok = await save({ ...schedule, view: next }, toastError);
  if (!ok) {
    viewGroup.value = schedule.view;
    return;
  }
  const v = VIEWS[next];
  toast(`Showing ${v.nouns}, ${v.axis[0]} → ${v.axis[v.axis.length - 1]}. Your schedule hasn't changed.`);
});

// The "Next: …" line moves on with the clock.
setInterval(() => {
  if (document.visibilityState === "visible") renderStatus();
}, 30_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // Not while a dialog is open: its plan refers to the periods on screen.
  if (!dlg.open && !copyDlg.open) void loadSchedule();
  void loadActivity();
});

render();
void loadSchedule();
void loadActivity();
