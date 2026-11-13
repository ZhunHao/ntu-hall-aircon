import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "../lib/theme";
import "../styles/settings.css";
import type { MeView, SessionInfo } from "../../shared/api";
import { api, ApiError } from "../lib/api";
import { dateSgt } from "../lib/format";
import { ICONS, type IconKey } from "../lib/icons";
import {
  apiErrorText,
  pairedRoom,
  pairErrorText,
  parsePairCode,
  roomAccountConfirm,
  SIGNOUT_CONFIRM,
} from "../lib/settings-logic";
import { mountShell } from "../lib/shell";
import { toast } from "../lib/toast";

const main = mountShell("settings");

function fromTemplate(id: string): DocumentFragment {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return document.importNode(tpl.content, true);
}
main.append(fromTemplate("settings-main"));
document.body.append(fromTemplate("settings-dialog"));
document.querySelectorAll<HTMLElement>("wa-icon[data-i]").forEach((el) => {
  el.setAttribute("library", "mdi");
  el.setAttribute("name", ICONS[el.dataset.i as IconKey]);
});

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Button = HTMLElement & { loading: boolean; disabled: boolean };
type Input = HTMLElement & { value: string; disabled: boolean };
type Dialog = HTMLElement & { open: boolean; label: string };

const pairInput = $<Input>("pair-code");
const pairBtn = $<Button>("pair-btn");
const raBtn = $<Button>("room-account-btn");
const dialog = $<Dialog>("confirm");
const confirmOk = $<Button>("confirm-ok");

let me: MeView | null = null;

function say(id: string, text: string | null, kind: "error" | "ok" = "error"): void {
  const el = $(id);
  el.hidden = text === null;
  el.classList.toggle("error", kind === "error");
  el.classList.toggle("ok", kind === "ok");
  if (text !== null) el.textContent = text;
}

// ---------- Render ----------
function render(): void {
  const room = pairedRoom(me);
  $("who").textContent = me?.firstname || me?.email || "—";
  $("room").textContent = room ?? "Not paired yet";

  const card = $("room-account-card");
  card.hidden = room === null;
  if (room !== null) {
    const holds = me?.aircon?.default_account === true;
    $("room-account-text").textContent = holds
      ? "You hold the Room Account"
      : "Whoever holds the Room Account is billed when someone uses the physical remote.";
    raBtn.hidden = holds;
  }
}

async function loadMe(): Promise<void> {
  try {
    me = await api<MeView>("GET", "/api/me");
    $("load-error").hidden = true;
  } catch (err) {
    const text = apiErrorText(err);
    if (text) {
      $("load-error-text").textContent = text;
      $("load-error").hidden = false;
    }
  }
  render();
}

async function loadSession(): Promise<void> {
  try {
    const info = await api<SessionInfo>("GET", "/api/session");
    if (info.valid && typeof info.expiresMs === "number") $("expiry").textContent = dateSgt(info.expiresMs);
  } catch {
    // The date stays a dash; a 401 is already on its way to the sign-in page.
  }
}

// ---------- Confirm dialog ----------
let pendingRun: (() => Promise<void>) | null = null;

/** Opens the shared confirm dialog. `run` starts when the resident confirms; the dialog closes when it finishes. */
function ask(label: string, message: string, action: string, run: () => Promise<void>): void {
  dialog.label = label;
  $("confirm-text").textContent = message;
  confirmOk.textContent = action;
  pendingRun = run;
  dialog.open = true;
}

confirmOk.addEventListener("click", async () => {
  const run = pendingRun;
  if (!run || confirmOk.loading) return;
  confirmOk.loading = true;
  try {
    await run();
  } finally {
    confirmOk.loading = false;
    pendingRun = null;
    dialog.open = false;
  }
});
dialog.addEventListener("wa-after-hide", (e) => {
  if (e.target === dialog && !confirmOk.loading) pendingRun = null;
});

// ---------- Pair ----------
$("pair-form").addEventListener("submit", (e) => {
  e.preventDefault();
  say("pair-msg", null);
  const parsed = parsePairCode(pairInput.value);
  if (!parsed.ok) {
    say("pair-msg", parsed.message);
    return;
  }
  const { code } = parsed;
  pairInput.value = code;
  ask("Pair this room?", `Pair your account with ${code}?`, "Pair", async () => {
    pairBtn.loading = true;
    try {
      await api("POST", "/api/pair", { code });
      pairInput.value = "";
      await loadMe();
      const room = pairedRoom(me);
      say("pair-msg", room ? `Paired with ${room}.` : "Paired.", "ok");
    } catch (err) {
      const text = pairErrorText(err);
      if (text) say("pair-msg", text);
    } finally {
      pairBtn.loading = false;
    }
  });
});
pairInput.addEventListener("input", () => say("pair-msg", null));

// ---------- Room Account ----------
raBtn.addEventListener("click", () => {
  const room = pairedRoom(me);
  if (room === null) return;
  say("room-account-msg", null);
  ask("Become the Room Account holder?", roomAccountConfirm(room), "Confirm", async () => {
    try {
      await api("POST", "/api/room-account", {});
      await loadMe();
      toast("You now hold the Room Account.", "success");
    } catch (err) {
      const text = apiErrorText(err);
      if (text) say("room-account-msg", text);
    }
  });
});

// ---------- Sign out ----------
$("signout").addEventListener("click", () => {
  ask("Sign out?", SIGNOUT_CONFIRM, "Sign out", async () => {
    try {
      await api("POST", "/api/signout", {});
    } catch (err) {
      // 401: the session had already ended, which is what the resident wanted. Anything else: still signed in.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast("Couldn't sign out. Try again.", "danger");
        return;
      }
    }
    location.assign("/signin");
  });
});

void loadMe();
void loadSession();
