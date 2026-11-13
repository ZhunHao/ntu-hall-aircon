import type { Fan, Mode } from "../shared/schedule";

export const DAIKIN_BASE = "https://apintu-prod.daikinpayu.com";

/** Daikin answered 402: the login is missing or expired. */
export class DaikinExpired extends Error {
  constructor() {
    super("Daikin login expired");
    this.name = "DaikinExpired";
  }
}

/** Any other Daikin failure. `status` is 0 when no HTTP response arrived. Messages never carry tokens, hashes or URLs. */
export class DaikinError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
    this.name = "DaikinError";
  }
}

export interface Aircon {
  power: 0 | 1;
  setpoint: number;
  mode: Mode;
  fanstep: Fan;
  flap: "N" | "S";
  comm_stat: number;
  maintenance_mode: number;
  aircon_code: string;
  current_temperature: number;
  room: { room_name: string };
}

export interface Me {
  email: string;
  firstname: string;
  balance: number;
  aircon: Aircon | null;
}

export interface Control {
  power?: 0 | 1;
  setpoint?: number;
  mode?: Mode;
  fanstep?: Fan;
  flap?: "N" | "S";
}

export interface UsageRow {
  starttime: string;
  endtime: string | null;
  duration: number;
  amount: number;
}

interface Body {
  meta: Record<string, unknown>;
  data: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class Daikin {
  private fetcher: typeof fetch;

  /** `fetcher` defaults to the global fetch; the dev fake supplies its own. */
  constructor(
    private jwt: string | null,
    fetcher?: typeof fetch,
    /** Covers the whole call, response body included. */
    private timeoutMs = 10_000,
  ) {
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  /** POST /auth/ad/callback: swap the single-use SAML hash for a 90-day JWT. */
  async exchange(hash: string): Promise<string> {
    const { data } = await this.call("POST", "/auth/ad/callback", {
      hash,
      fcm_token: "placeholder",
    });
    if (!isObject(data) || typeof data.token !== "string" || data.token === "") {
      throw new DaikinError(502, "Daikin sent no login token");
    }
    return data.token;
  }

  async me(): Promise<Me> {
    const { data } = await this.call("GET", "/me");
    if (!isObject(data)) throw new DaikinError(502, "Daikin sent an unexpected profile");
    return { ...data, aircon: (data.aircon ?? null) as Aircon | null } as unknown as Me;
  }

  async control(c: Control): Promise<void> {
    const form: Record<string, string> = {};
    for (const key of ["power", "setpoint", "mode", "fanstep", "flap"] as const) {
      if (c[key] !== undefined) form[key] = String(c[key]);
    }
    await this.call("POST", "/v2/ac/control", form);
  }

  async usage(limit: number, offset: number): Promise<{ rows: UsageRow[]; total: number }> {
    const { meta, data } = await this.call("GET", `/usage/history${page(limit, offset)}`);
    if (!Array.isArray(data)) throw new DaikinError(502, "Daikin sent unexpected usage history");
    const total = typeof meta.rowCount === "number" ? meta.rowCount : data.length;
    return { rows: data as UsageRow[], total };
  }

  async topups(limit: number, offset: number): Promise<unknown> {
    return (await this.call("GET", `/topup/history${page(limit, offset)}`)).data;
  }

  async notifications(limit: number, offset: number): Promise<unknown> {
    return (await this.call("GET", `/notification${page(limit, offset)}`)).data;
  }

  async config(key: string): Promise<unknown> {
    return (await this.call("GET", `/app-config/${encodeURIComponent(key)}`)).data;
  }

  async faq(): Promise<unknown> {
    return (await this.call("GET", "/faq")).data;
  }

  async pair(code: string): Promise<void> {
    await this.call("POST", "/ac/pair", { code });
  }

  async makeDefault(code: string): Promise<void> {
    await this.call("POST", "/ac/default", { code });
  }

  async topup(
    amount: number,
    type: "PayNow" | "VisaMaster",
  ): Promise<{ qrcode?: string; payment_url?: string }> {
    const { data } = await this.call("POST", "/topup", { amount: String(amount), type });
    if (!isObject(data)) throw new DaikinError(502, "Daikin sent an unexpected top-up");
    const out: { qrcode?: string; payment_url?: string } = {};
    if (typeof data.qrcode === "string") out.qrcode = data.qrcode;
    if (typeof data.payment_url === "string") out.payment_url = data.payment_url;
    return out;
  }

  /** One Daikin request. Explicit headers only: no Cookie is sent and no set-cookie is read. */
  private async call(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<Body> {
    const headers: Record<string, string> = {
      "User-Agent": "Dart/3.0 (dart:io)",
      Accept: "application/json",
    };
    if (this.jwt) headers.Authorization = `Bearer ${this.jwt}`;
    const ctl = new AbortController();
    const init: RequestInit = { method, headers, signal: ctl.signal };
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }

    // One deadline for connect + headers + body. The race also covers a fetcher that ignores the signal.
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const timedOut = new Promise<never>((_, reject) =>
      ctl.signal.addEventListener("abort", () => reject(new DaikinError(0, "Daikin timed out"))),
    );
    timedOut.catch(() => {}); // the race below may have settled already

    let res: Response;
    let text: string;
    try {
      try {
        res = await Promise.race([this.fetcher(`${DAIKIN_BASE}${path}`, init), timedOut]);
      } catch (e) {
        throw e instanceof DaikinError ? e : new DaikinError(0, "Could not reach Daikin");
      }

      if (res.status === 402) {
        void res.body?.cancel().catch(() => {});
        throw new DaikinExpired();
      }

      try {
        text = await Promise.race([res.text(), timedOut]);
      } catch (e) {
        throw e instanceof DaikinError ? e : new DaikinError(res.status, "Daikin response could not be read");
      }
    } finally {
      clearTimeout(timer);
    }
    const json = parseObject(text);

    if (!res.ok) {
      const note = typeof json?.message === "string" ? `: ${json.message.slice(0, 200)}` : "";
      throw new DaikinError(res.status, `Daikin returned ${res.status}${note}`);
    }
    if (!json) throw new DaikinError(res.status, "Daikin sent an unreadable response");
    return { meta: isObject(json.meta) ? json.meta : {}, data: json.data };
  }
}

function page(limit: number, offset: number): string {
  return `?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Reads `email` and `exp` (seconds) from the payload. The signature is Daikin's HS256 and cannot be checked here. */
export function jwtClaims(jwt: string): { email: string; exp: number } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("bad-jwt");
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))),
    );
    if (
      isObject(payload) &&
      typeof payload.email === "string" &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp)
    ) {
      return { email: payload.email, exp: payload.exp };
    }
  } catch {
    // fall through
  }
  throw new Error("bad-jwt");
}
