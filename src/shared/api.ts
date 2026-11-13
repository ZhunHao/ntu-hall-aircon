export interface Activity {
  id: number;
  at: number;
  kind: "start" | "end" | "resume" | "apply";
  summary: string;
  result: "done" | "skipped" | "failed";
  /**
   * Our own short wording, except after a failed Daikin call, where it can carry up to 200 characters of
   * Daikin's message. Render it as text (textContent), never as HTML.
   */
  reason?: string;
}

/** Answer of `session()`. `email` and `expiresMs` are present only when `valid` is true. */
export interface SessionInfo {
  valid: boolean;
  email?: string;
  expiresMs?: number;
  expired?: boolean;
}

/** What every proxy RPC on `Home` returns. It never throws. `error` is a short code, never Daikin's text (unlike `Activity.reason`). */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 401 | 502; error: string };

/** The paired aircon as the browser sees it. Only these fields leave the server. */
export interface AirconView {
  power: 0 | 1;
  setpoint: number;
  mode: "C" | "D" | "F" | "A";
  fanstep: "A" | "L" | "LM" | "M" | "MH" | "H";
  flap: "N" | "S";
  comm_stat: number;
  maintenance_mode: number;
  aircon_code: string;
  /** Null when the unit sends no reading, e.g. while offline. */
  current_temperature: number | null;
  room: { room_name: string };
  /** True when this account is the Room Account holder (Daikin's `default_account` is this user). */
  default_account: boolean;
}

/** `me()` answer. A projection of Daikin's `/me`: ids, residence and wallet details are dropped. */
export interface MeView {
  email: string;
  firstname: string;
  balance: number;
  aircon: AirconView | null;
}

/** `config()` answer. `faq` is Daikin's text as sent; render it defensively. */
export interface ConfigView {
  tempMin: number;
  tempMax: number;
  amounts: number[];
  faq: unknown;
}

export interface UsageRowView {
  starttime: string;
  endtime: string | null;
  duration: number;
  amount: number;
}

export interface TopUpView {
  qrcode?: string;
  payment_url?: string;
}

/** One wallet top-up. Only what a resident reads; ids, names, e-mail and transaction refs stay on the server. */
export interface TopUpRowView {
  type: string;
  created_on: string;
  amount: number;
  /** Daikin's numeric status code, passed through. */
  status: number;
}

/** One notification. `status` is Daikin's flag as sent. */
export interface NotificationView {
  title: string;
  message: string;
  send_on: string;
  status: boolean;
}
