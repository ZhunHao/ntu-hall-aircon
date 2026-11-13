import { DurableObject } from "cloudflare:workers";
import { onSummary } from "../shared/events";
import { validate, type Period, type Problem, type Schedule } from "../shared/schedule";
import { extractCode } from "../shared/signin";
import type { Activity, ApiResult, AirconView, ConfigView, MeView, NotificationView, SessionInfo, TopUpRowView, TopUpView, UsageRowView } from "../shared/api";
import type { Env } from "../worker/index";
import { decrypt, encrypt, randomToken, sha256Hex, validSecret } from "./crypto";
import { Daikin, DaikinError, DaikinExpired, jwtClaims } from "./daikin";
import type { Control } from "./daikin";
import { fakeFetch } from "./fake";
import { findDue, loadSchedule, markDone, nextWake, periodAt, runConfirm, runDue, send, startCommand, type Pending, type RunCtx } from "./runner";
import { Store } from "./store";

const ATTEMPT_WINDOW_MS = 10 * 60_000;
const MAX_PER_IP = 5;
const MAX_TOTAL = 50;
/** The value shipped in `.dev.vars.example`; a copy still using it is not set up. */
const PLACEHOLDER_OWNER = "your-id@e.ntu.edu.sg";

const MODES = ["C", "D", "F", "A"];
const FANS = ["A", "L", "LM", "M", "MH", "H"];
const CONTROL_KEYS = ["power", "setpoint", "mode", "fanstep", "flap"];
const AMOUNTS = [10, 20, 30, 40, 50];
const PAY_TYPES = ["PayNow", "VisaMaster"];
const PAIR_CODE = /^H\d+-\d{2}-\d{2}-\d{4}-\d{2}$/;
const MAX_PAGE = 50;
const MAX_PERIODS = 100;
const MAX_ACTIVITY = 200;
const VIEWS = ["nights", "days"];

/** Thrown inside a proxy call to answer with a validation error. */
class Reject extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (error: string): ApiResult<never> => ({ ok: false, status: 400, error });

/** A clean `Control` from untrusted input, or null. Every present field is checked; unknown keys and `{}` fail. */
function parseControl(c: unknown): Control | null {
  if (!isRecord(c)) return null;
  const keys = Object.keys(c);
  if (keys.length === 0 || keys.some((k) => !CONTROL_KEYS.includes(k))) return null;
  const out: Control = {};
  if ("power" in c) {
    if (c.power !== 0 && c.power !== 1) return null;
    out.power = c.power;
  }
  if ("setpoint" in c) {
    const v = c.setpoint;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 22 || v > 26) return null;
    out.setpoint = v;
  }
  if ("mode" in c) {
    if (typeof c.mode !== "string" || !MODES.includes(c.mode)) return null;
    out.mode = c.mode as Control["mode"];
  }
  if ("fanstep" in c) {
    if (typeof c.fanstep !== "string" || !FANS.includes(c.fanstep)) return null;
    out.fanstep = c.fanstep as Control["fanstep"];
  }
  if ("flap" in c) {
    if (c.flap !== "N" && c.flap !== "S") return null;
    out.flap = c.flap;
  }
  return out;
}

const validPage = (limit: unknown, offset: unknown): boolean =>
  typeof limit === "number" &&
  Number.isInteger(limit) &&
  limit >= 1 &&
  limit <= MAX_PAGE &&
  typeof offset === "number" &&
  Number.isInteger(offset) &&
  offset >= 0;

/** The browser-safe view of Daikin's `/me` data. Throws DaikinError when the shape is wrong. */
function projectMe(raw: unknown): MeView {
  if (!isRecord(raw)) throw new DaikinError(502, "Daikin sent an unexpected profile");
  const { email, firstname, balance, aircon } = raw;
  if (typeof email !== "string" || typeof firstname !== "string" || typeof balance !== "number") {
    throw new DaikinError(502, "Daikin sent an unexpected profile");
  }
  return { email, firstname, balance, aircon: aircon == null ? null : projectAircon(aircon, raw.user_id) };
}

function projectAircon(a: unknown, userId: unknown): AirconView {
  if (!isRecord(a) || !isRecord(a.room) || typeof a.room.room_name !== "string") {
    throw new DaikinError(502, "Daikin sent an unexpected aircon");
  }
  return {
    power: a.power as AirconView["power"],
    setpoint: a.setpoint as number,
    mode: a.mode as AirconView["mode"],
    fanstep: a.fanstep as AirconView["fanstep"],
    flap: a.flap as AirconView["flap"],
    comm_stat: a.comm_stat as number,
    maintenance_mode: a.maintenance_mode as number,
    aircon_code: a.aircon_code as string,
    current_temperature:
      typeof a.current_temperature === "number" && Number.isFinite(a.current_temperature) ? a.current_temperature : null,
    room: { room_name: a.room.room_name },
    default_account: userId !== undefined && userId !== null && a.default_account === userId,
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Keep object rows only, each reduced to the fields a resident reads. */
function projectRows<T>(data: unknown, pick: (r: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(data)) throw new DaikinError(502, "Daikin sent an unexpected list");
  return data.filter(isRecord).map(pick);
}

const usageRow = (r: Record<string, unknown>): UsageRowView => ({
  starttime: str(r.starttime),
  endtime: typeof r.endtime === "string" ? r.endtime : null,
  duration: num(r.duration),
  amount: num(r.amount),
});

const topUpRow = (r: Record<string, unknown>): TopUpRowView => ({
  type: str(r.type),
  created_on: str(r.created_on),
  amount: num(r.amount),
  status: num(r.status),
});

const notificationRow = (r: Record<string, unknown>): NotificationView => ({
  title: str(r.title),
  message: str(r.message),
  send_on: str(r.send_on),
  status: r.status === true,
});

/** `/app-config/<key>` answers `{ value }`; numbers may arrive as strings. */
function configNumber(data: unknown): number {
  const v = isRecord(data) ? data.value : undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new DaikinError(502, "Daikin sent an unexpected setting");
  return n;
}

/** Enabled top-up amounts from `payment_dominations`. */
function configAmounts(data: unknown): number[] {
  const v = isRecord(data) ? data.value : undefined;
  if (!Array.isArray(v)) throw new DaikinError(502, "Daikin sent unexpected top-up amounts");
  return v.flatMap((x) =>
    isRecord(x) && x.enable === true && typeof x.amount === "number" && Number.isFinite(x.amount) ? [x.amount] : [],
  );
}

/**
 * A clean `Schedule` from untrusted input, or null when the body has the wrong shape. Values are
 * left for `validate()`; only the period fields are kept.
 */
function parseSchedule(s: unknown): Schedule | null {
  if (!isRecord(s) || typeof s.enabled !== "boolean" || typeof s.view !== "string" || !VIEWS.includes(s.view)) return null;
  if (!Array.isArray(s.periods) || s.periods.length > MAX_PERIODS) return null;
  const periods: Period[] = [];
  for (const p of s.periods) {
    if (
      !isRecord(p) ||
      typeof p.day !== "number" ||
      typeof p.start !== "string" ||
      typeof p.end !== "string" ||
      typeof p.setpoint !== "number" ||
      typeof p.mode !== "string" ||
      typeof p.fan !== "string"
    ) {
      return null;
    }
    periods.push({ day: p.day, start: p.start, end: p.end, setpoint: p.setpoint, mode: p.mode, fan: p.fan } as Period);
  }
  return { periods, enabled: s.enabled, view: s.view as Schedule["view"] };
}

export type PutScheduleResult = { ok: true } | { ok: false; problems: Problem[] };

export type SignInResult =
  | { ok: true; token: string; expiresMs: number }
  | { ok: false; error: "rate-limited" | "no-code" | "rejected" | "not-owner" | "not-configured" };

const norm = (s: string | undefined): string => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** True when both addresses are non-empty and equal, ignoring case and surrounding spaces. */
export function isOwner(ownerEmail: string, jwtEmail: string): boolean {
  const owner = norm(ownerEmail);
  return owner !== "" && owner === norm(jwtEmail);
}

/** False when OWNER_EMAIL is missing, blank or still the placeholder, or SESSION_SECRET is not 64 hex chars. */
export function configured(e: Pick<Env, "OWNER_EMAIL" | "SESSION_SECRET">): boolean {
  const owner = norm(e.OWNER_EMAIL);
  return owner !== "" && owner !== PLACEHOLDER_OWNER && validSecret(e.SESSION_SECRET);
}

export class Home extends DurableObject<Env> {
  protected store!: Store;
  private fakeFetcher?: typeof fetch;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new Store(ctx.storage.sql);
    });
  }

  /** The dev fake keeps its state in a closure, so there is exactly one per instance. */
  private fake(): typeof fetch {
    return (this.fakeFetcher ??= fakeFetch(this.env.OWNER_EMAIL));
  }

  /**
   * Point the single alarm at the next thing to do, or clear it. `from` is the alarm's start time when
   * re-arming after a run, so an event that came due during slow Daikin calls fires at once instead of being skipped.
   */
  protected async arm(from = Date.now()): Promise<void> {
    const at = nextWake(this.store, from);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  private runCtx(now: number): RunCtx {
    return { store: this.store, daikin: () => this.daikin(), now };
  }

  /**
   * Swap the pasted sign-in page address for a Daikin login and open a session.
   * `fake` is decided by the Worker (localhost with DAIKIN_FAKE=1 only) and is remembered for the alarm.
   */
  async signIn(text: string, ip: string, fake = false): Promise<SignInResult> {
    if (!configured(this.env)) return { ok: false, error: "not-configured" };

    const now = Date.now();
    if (!this.store.attempt(ip, now, ATTEMPT_WINDOW_MS, { perIp: MAX_PER_IP, total: MAX_TOTAL }).allowed) {
      return { ok: false, error: "rate-limited" };
    }

    const parsed = extractCode(text);
    if ("error" in parsed) return { ok: false, error: "no-code" };

    let jwt: string;
    let claims: { email: string; exp: number };
    try {
      jwt = await new Daikin(null, fake ? this.fake() : undefined).exchange(parsed.code);
      claims = jwtClaims(jwt);
    } catch {
      // Any failure here, including a 402, means this paste did not work. Never report "expired".
      return { ok: false, error: "rejected" };
    }
    if (!isOwner(this.env.OWNER_EMAIL, claims.email)) return { ok: false, error: "not-owner" };
    // A login that has already lapsed would open a session that ends at once; store nothing.
    if (claims.exp * 1000 <= now) return { ok: false, error: "rejected" };

    const blob = await encrypt(this.env.SESSION_SECRET, jwt);
    const token = randomToken();
    const hash = await sha256Hex(token);
    const expiresMs = claims.exp * 1000;

    // A different owner must not inherit the former owner's sessions or half-finished command.
    const prev = this.store.get<string>("email");
    if (prev !== undefined && norm(prev) !== norm(claims.email)) {
      this.store.clearSessions();
      this.store.del("pending");
      this.store.del("done");
    }
    // A check left over from a lapsed or ended login must not resend an old command.
    if (this.store.get<string>("jwt") === undefined || this.store.get<boolean>("expired") === true) {
      this.store.del("pending");
    }
    this.store.put("jwt", blob);
    this.store.put("jwtExp", expiresMs);
    this.store.put("email", claims.email);
    this.store.put("fake", fake);
    this.store.del("expired");
    this.store.addSession(hash, expiresMs);
    try {
      await this.arm();
    } catch (e) {
      // The login is stored; the next schedule save or sign-in re-arms.
      console.error("arm failed:", e instanceof Error ? e.name : "unknown");
    }
    return { ok: true, token, expiresMs };
  }

  /** `email` and `expiresMs` are only revealed for a valid session. */
  async session(tokenHash: string): Promise<SessionInfo> {
    if (!this.store.hasSession(tokenHash, Date.now())) return { valid: false };
    // OWNER_EMAIL may have changed since this login was stored.
    if (this.storedOwnerChanged()) return { valid: false };
    const info: SessionInfo = {
      valid: true,
      expired: this.store.get<boolean>("expired") === true,
    };
    const email = this.store.get<string>("email");
    if (email !== undefined) info.email = email;
    const exp = this.store.get<number>("jwtExp");
    if (exp !== undefined) info.expiresMs = exp;
    return info;
  }

  /** True when a login is stored for an address that is no longer OWNER_EMAIL. */
  private storedOwnerChanged(): boolean {
    const email = this.store.get<string>("email");
    return email !== undefined && !isOwner(this.env.OWNER_EMAIL, email);
  }

  /** Ends every session and forgets the login. The schedule is kept. Does not call Daikin. */
  async signOut(): Promise<void> {
    this.store.clearSessions();
    for (const key of ["jwt", "jwtExp", "email", "fake", "pending"]) this.store.del(key);
    await this.ctx.storage.deleteAlarm();
  }

  /** A Daikin client for the stored login. Throws DaikinExpired when there is none or it has lapsed. */
  protected async daikin(): Promise<Daikin> {
    const blob = this.store.get<string>("jwt");
    const exp = this.store.get<number>("jwtExp");
    if (
      blob === undefined ||
      this.store.get<boolean>("expired") === true ||
      exp === undefined ||
      exp <= Date.now()
    ) {
      throw new DaikinExpired();
    }
    const jwt = await decrypt(this.env.SESSION_SECRET, blob);
    return new Daikin(jwt, this.store.get<boolean>("fake") === true ? this.fake() : undefined);
  }

  /**
   * Run one Daikin call and turn every outcome into an ApiResult. Never throws, never logs payloads.
   * An expired login also sets kv `expired`, so `session()` tells the browser to sign in again.
   */
  private async proxy<T>(fn: (d: Daikin) => Promise<T>): Promise<ApiResult<T>> {
    try {
      return { ok: true, data: await fn(await this.daikin()) };
    } catch (e) {
      if (e instanceof Reject) return bad(e.code);
      if (e instanceof DaikinExpired) {
        this.store.put("expired", true);
        return { ok: false, status: 401, error: "expired" };
      }
      if (!(e instanceof DaikinError)) console.error("proxy failed:", e instanceof Error ? e.name : "unknown");
      return { ok: false, status: 502, error: "daikin" };
    }
  }

  /** The signed-in resident and their paired aircon (a projection of Daikin's `/me`). */
  me(): Promise<ApiResult<MeView>> {
    return this.proxy(async (d) => projectMe(await d.me()));
  }

  /**
   * Send a control command. `c` comes from the browser, so every field is checked here.
   * A manual change wins: a scheduled command still waiting for its confirm check is dropped, so it is never resent.
   */
  async control(c: unknown): Promise<ApiResult<null>> {
    const clean = parseControl(c);
    if (!clean) return bad("invalid-control");
    return this.proxy(async (d) => {
      await d.control(clean);
      const p = this.store.get<Pending>("pending");
      if (p) {
        this.store.del("pending");
        this.store.log({ at: Date.now(), kind: p.kind, summary: p.summary, result: "skipped", reason: "you changed it" });
      }
      return null;
    });
  }

  async usage(limit: number, offset: number): Promise<ApiResult<{ rows: UsageRowView[]; total: number }>> {
    if (!validPage(limit, offset)) return bad("invalid-page");
    return this.proxy(async (d) => {
      const { rows, total } = await d.usage(limit, offset);
      return { rows: projectRows(rows, usageRow), total };
    });
  }

  async topups(limit: number, offset: number): Promise<ApiResult<TopUpRowView[]>> {
    if (!validPage(limit, offset)) return bad("invalid-page");
    return this.proxy(async (d) => projectRows(await d.topups(limit, offset), topUpRow));
  }

  async notifications(limit: number, offset: number): Promise<ApiResult<NotificationView[]>> {
    if (!validPage(limit, offset)) return bad("invalid-page");
    return this.proxy(async (d) => projectRows(await d.notifications(limit, offset), notificationRow));
  }

  /** Temperature limits, enabled top-up amounts and the FAQ. */
  config(): Promise<ApiResult<ConfigView>> {
    return this.proxy(async (d) => {
      const [min, max, amounts, faq] = await Promise.all([
        d.config("temperature_allowed_min"),
        d.config("temperature_allowed_max"),
        d.config("payment_dominations"),
        d.faq(),
      ]);
      return { tempMin: configNumber(min), tempMax: configNumber(max), amounts: configAmounts(amounts), faq };
    });
  }

  async pair(code: string): Promise<ApiResult<null>> {
    if (typeof code !== "string" || !PAIR_CODE.test(code)) return bad("invalid-code");
    return this.proxy(async (d) => {
      await d.pair(code);
      return null;
    });
  }

  /** Become Room Account holder for the paired aircon. The code comes from `/me`, never from the browser. */
  roomAccount(): Promise<ApiResult<null>> {
    return this.proxy(async (d) => {
      const me = await d.me();
      const code = me.aircon?.aircon_code;
      if (typeof code !== "string" || code === "") throw new Reject("not-paired");
      await d.makeDefault(code);
      return null;
    });
  }

  async topup(amount: number, type: string): Promise<ApiResult<TopUpView>> {
    if (!AMOUNTS.includes(amount) || !PAY_TYPES.includes(type)) return bad("invalid-topup");
    return this.proxy((d) => d.topup(amount, type as "PayNow" | "VisaMaster"));
  }

  async getSchedule(): Promise<Schedule> {
    return loadSchedule(this.store);
  }

  /**
   * Validate and store the schedule, then re-arm. Never switches the aircon.
   * A body with the wrong shape (not the schedule's types, or over 100 periods) answers `problems: []`.
   */
  async putSchedule(s: unknown): Promise<PutScheduleResult> {
    const clean = parseSchedule(s);
    if (!clean) return { ok: false, problems: [] };
    const problems = validate(clean);
    if (problems.length > 0) return { ok: false, problems };
    this.store.put("schedule", clean);
    // Occurrences before this save never run, so a later alarm (e.g. a confirm check) can't catch one up.
    this.store.put("savedAt", Date.now());
    await this.arm();
    return { ok: true };
  }

  /** Send the start command for the period covering now, if the schedule is on. Confirmed by the alarm. */
  applyNow(): Promise<ApiResult<{ applied: boolean }>> {
    return this.proxy(async (d) => {
      const now = Date.now();
      const s = loadSchedule(this.store);
      const p = s.enabled ? periodAt(s.periods, now) : undefined;
      if (!p) return { applied: false };
      const summary = onSummary(p);
      // Apply now stands in for the occurrence due now, so the alarm must never send it again.
      const due = findDue(this.store, now);
      if (due) markDone(this.store, due.key);
      try {
        await send(this.runCtx(now), d, { key: `apply#${now}`, kind: "apply", summary, expect: startCommand(p) });
      } catch (e) {
        if (e instanceof DaikinError) this.store.log({ at: now, kind: "apply", summary, result: "failed", reason: e.message });
        throw e;
      }
      await this.arm();
      return { applied: true };
    });
  }

  /** Newest first, at most 200. */
  async activity(limit: number): Promise<Activity[]> {
    const n = Number.isFinite(limit) ? Math.trunc(limit) : MAX_ACTIVITY;
    return this.store.activity(Math.min(MAX_ACTIVITY, Math.max(1, n)));
  }

  /** Confirm a pending command if its check is due, run the due event, prune, re-arm. Never throws for Daikin. */
  async alarm(): Promise<void> {
    if (this.storedOwnerChanged()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (this.store.get<string>("jwt") === undefined || this.store.get<boolean>("expired") === true) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const ctx = this.runCtx(now);
    const p = this.store.get<Pending>("pending");
    if (p && p.checkAtMs <= now) await runConfirm(ctx, p);
    if (this.store.get<boolean>("expired") !== true) await runDue(ctx);
    this.store.prune(now);
    await this.arm(now);
  }
}
