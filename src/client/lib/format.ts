import type { Fan } from "../../shared/schedule";

/** "S$12.40". Negative amounts read "-S$1.20". */
export function sgd(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  const text = `S$${(cents / 100).toFixed(2)}`;
  return n < 0 && cents > 0 ? `-${text}` : text;
}

const FAN_LABELS: Record<Fan, string> = { A: "Auto", L: "1", LM: "2", M: "3", MH: "4", H: "5" };
const FAN_FROM_UI: Record<"A" | "1" | "2" | "3" | "4" | "5", Fan> = {
  A: "A",
  "1": "L",
  "2": "LM",
  "3": "M",
  "4": "MH",
  "5": "H",
};

/** What a resident sees for a Daikin fan step: Auto, 1 to 5. */
export function fanLabel(f: Fan): string {
  return FAN_LABELS[f];
}

/** The fan button the resident pressed (Auto, 1 to 5) to the Daikin fan step. */
export function fanFromUi(n: "A" | "1" | "2" | "3" | "4" | "5"): Fan {
  return FAN_FROM_UI[n];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "28 Jan 2027", the calendar day in Singapore (fixed UTC+8). */
export function dateSgt(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "30 Oct 2026, 23:00", Singapore wall-clock time (fixed UTC+8), whatever the browser's timezone is. */
export function dateTimeSgt(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dateSgt(ms)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** A PayNow QR is shown only when it is a base64 PNG data URL. Daikin's text is untrusted. */
export function safeQr(s: unknown): string | null {
  return typeof s === "string" && PNG_DATA_URL.test(s) ? s : null;
}

/** A payment link is opened only when it is https. Returns the normalised href. */
export function safeHttpsUrl(s: unknown): string | null {
  if (typeof s !== "string") return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
