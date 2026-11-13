import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import "../lib/theme";
import "../styles/signin.css";
import type { MeView, SessionInfo } from "../../shared/api";
import { extractCode } from "../../shared/signin";
import { api } from "../lib/api";
import { dateSgt, sgd } from "../lib/format";
import { icon } from "../lib/icons";
import { signinStart, type SigninStart } from "../lib/session-logic";
import { signinOutcome } from "../lib/signin-errors";
import { toggleScheme } from "../lib/theme";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const wrap = $("wrap");
const paste = $<WaInput>("paste");
const found = $("found");
const submitError = $("submit-error");
const finish = $<HTMLElement & { disabled: boolean }>("finish");

type Screen = "welcome" | "busy" | "success" | "rejected" | "expired";

/** Shows one screen (or step 1 or 2 of the sign-in steps) and hides the rest. */
function go(target: Screen | "1" | "2"): void {
  const step = target === "1" || target === "2" ? Number(target) : 0;
  const screen = step ? "steps" : target;
  document.querySelectorAll<HTMLElement>("[data-screen]").forEach((s) => {
    s.hidden = s.dataset.screen !== screen;
  });
  if (step) {
    document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => {
      p.hidden = Number(p.dataset.panel) !== step;
    });
    document.querySelectorAll<HTMLElement>("[data-step]").forEach((s) => {
      const n = Number(s.dataset.step);
      s.classList.toggle("on", n === step);
      s.classList.toggle("done", n < step);
      s.querySelector(".dot")!.textContent = n < step ? "✓" : String(n);
    });
  }
  wrap.classList.toggle("wide", step === 2);
  scrollTo({ top: 0 });
  // Move focus to the new screen's heading so keyboard and screen-reader users land on it.
  const visible = document.querySelector<HTMLElement>("[data-screen]:not([hidden])");
  visible?.querySelector<HTMLElement>("[data-panel]:not([hidden]) h1, h1, strong[tabindex]")?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-go]");
  if (b) go(b.dataset.go as Screen | "1" | "2");
});

$("scheme").addEventListener("click", () => toggleScheme());
// The link opens NTU in a new tab by itself (href, target and rel are on the button); this moves this tab on.
$("open-ntu").addEventListener("click", () => go("2"));

/** First 4 and last 3 characters of the code, so a resident can recognise it without showing all of it. */
const mask = (c: string) => `${c.slice(0, 4)}…${c.slice(-3)}`;

function check(): void {
  submitError.hidden = true;
  const r = extractCode(paste.value ?? "");
  const code = "code" in r ? r.code : null;
  const error = "error" in r ? r.error : "";
  found.hidden = !code && !error;
  found.className = "found " + (code ? "ok" : "bad");
  found.replaceChildren(icon(code ? "check" : "alert"));
  if (code) {
    const c = document.createElement("code");
    c.className = "mask";
    c.textContent = mask(code);
    found.append("Found your sign-in code ", c);
  } else {
    found.append(error);
  }
  finish.disabled = !code;
}

paste.addEventListener("input", check);
paste.addEventListener("wa-clear", check);
$("paste-btn").addEventListener("click", async () => {
  try {
    paste.value = await navigator.clipboard.readText();
    check();
  } catch {
    found.hidden = false;
    found.className = "found bad";
    found.textContent = "Your browser blocked clipboard access. Long-press the box and choose Paste.";
  }
});

function setText(id: string, text: string): void {
  $(id).textContent = text;
}

/** Fills the success screen from /api/me and /api/session. A failed call leaves "—" there. */
async function showSuccess(): Promise<void> {
  const [me, session] = await Promise.allSettled([
    api<MeView>("GET", "/api/me"),
    api<SessionInfo>("GET", "/api/session"),
  ]);
  if (me.status === "fulfilled" && me.value) {
    setText("who", me.value.firstname || me.value.email);
    setText("aircon", me.value.aircon?.aircon_code ?? "Not paired yet");
    setText("wallet", sgd(me.value.balance));
  }
  if (session.status === "fulfilled" && typeof session.value?.expiresMs === "number") {
    setText("expiry", dateSgt(session.value.expiresMs));
  }
  go("success");
}

finish.addEventListener("click", async () => {
  const text = paste.value ?? "";
  if (!("code" in extractCode(text))) return;
  // The pasted text is never logged or stored. The field is emptied as soon as it is sent.
  paste.value = "";
  check();
  go("busy");
  try {
    await api("POST", "/api/signin", { text });
  } catch (err) {
    const out = signinOutcome(err, text);
    if (out.screen === "rejected") {
      go("rejected");
    } else {
      go("2");
      submitError.textContent = out.message;
      submitError.hidden = false;
    }
    return;
  }
  await showSuccess();
});

/** Shows the screen `signinStart` picked. "home" leaves the page. */
function openScreen(start: SigninStart): void {
  if (start === "home") {
    location.replace("/");
    return;
  }
  go(start === "steps" ? "1" : start);
  wrap.hidden = false;
}

async function start(): Promise<void> {
  // #expired and #renew don't depend on the session, so skip the call.
  const quick = signinStart(location.hash, null);
  if (quick !== "welcome") return openScreen(quick);
  let info: SessionInfo | null = null;
  try {
    info = await api<SessionInfo>("GET", "/api/session");
  } catch {
    // Not reachable: show the sign-in screens anyway.
  }
  openScreen(signinStart(location.hash, info));
}

// A link to /signin#expired or #renew while this page is already open does not reload it.
addEventListener("hashchange", () => {
  const s = signinStart(location.hash, null);
  if (s !== "welcome") openScreen(s);
});

void start();
