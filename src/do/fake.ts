import { DAIKIN_BASE, type Control } from "./daikin";

// Dev-only stand-in for Daikin's API. It never touches the network and never
// reads env: the caller decides when to use it (see S6) and passes it to
// `new Daikin(jwt, fakeFetch(ownerEmail))`.

const APPLY_DELAY_MS = 4000;
const SGT_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const JWT_LIFETIME_S = 90 * 86_400;
/** A real 1x1 PNG, standing in for the PayNow QR. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** `.invalid` never resolves (RFC 2606), so this cannot reach a real payment page. */
const PAYMENT_URL = "https://example.invalid/enets";

const MODES = ["C", "D", "F", "A"];
const FANS = ["A", "L", "LM", "M", "MH", "H"];
const AMOUNTS = [10, 20, 30, 40, 50];

const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Daikin upper-cases the local part of the email in its JWT and /me. */
function daikinEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? email.toUpperCase() : email.slice(0, at).toUpperCase() + email.slice(at);
}

/** Local time as `…+08:00`, the way Daikin formats timestamps. */
function sgt(ms: number): string {
  return new Date(ms + SGT_MS).toISOString().replace("Z", "+08:00");
}

export function fakeFetch(
  ownerEmail = "abc123@e.ntu.edu.sg",
  /** Injectable clock for tests; defaults to `Date.now()` so vi fake timers apply. */
  now: () => number = () => Date.now(),
): typeof fetch {
  const email = daikinEmail(ownerEmail);
  const state = {
    power: 0,
    setpoint: 24,
    mode: "C",
    fanstep: "A",
    flap: "N",
    aircon_code: "H11-12-34-5678-01",
    balance: 10,
  };
  let pending: { at: number; change: Control }[] = [];

  const settle = (): void => {
    const t = now();
    const due = pending.filter((p) => p.at <= t);
    pending = pending.filter((p) => p.at > t);
    for (const p of due) Object.assign(state, p.change);
  };

  const ok = (data?: unknown, extraMeta: object = {}): Response =>
    Response.json({ meta: { status: 200, ...extraMeta }, ...(data === undefined ? {} : { data }) });
  const fail = (status: number, message: string): Response =>
    Response.json({ meta: { status, message } }, { status });

  const paged = (rows: unknown[], q: URLSearchParams): Response => {
    const limit = Math.max(1, Number(q.get("limit")) || 10);
    const offset = Math.max(0, Number(q.get("offset")) || 0);
    return ok(rows.slice(offset, offset + limit), {
      offset,
      limit,
      rowCount: rows.length,
      pageCount: Math.ceil(rows.length / limit),
    });
  };

  const usageRows = (): unknown[] => {
    // One night per day, 23:00 to 07:00 (480 min, S$0.0065/min), newest first.
    const day = Math.floor((now() + SGT_MS) / DAY_MS) * DAY_MS - SGT_MS;
    return Array.from({ length: 12 }, (_, i) => {
      const start = day - i * DAY_MS - DAY_MS + 23 * 3600_000;
      return {
        starttime: sgt(start),
        endtime: sgt(start + 8 * 3600_000),
        id: 10_000_380 - i,
        aircon_id: 4242,
        user_id: 100_001,
        rate: 0.0065,
        duration: 480,
        amount: 3.12,
        aircon_name: state.aircon_code,
        activate_type: 1,
      };
    });
  };

  const config = (key: string): unknown => {
    const entries: Record<string, unknown> = {
      temperature_allowed_min: { value: 22, type: "INTEGER" },
      temperature_allowed_max: { value: 26, type: "INTEGER" },
      wallet_balance_min: { value: 0, type: "FLOAT" },
      payment_types: {
        value: [
          { type_name: "PayNow", enable: true },
          { type_name: "VisaMaster", enable: true },
        ],
        type: "JSON",
      },
      payment_dominations: {
        value: AMOUNTS.map((amount) => ({ amount, enable: true })),
        type: "JSON",
      },
    };
    return key in entries ? { ...(entries[key] as object), name: key } : undefined;
  };

  const route = async (
    method: string,
    path: string,
    q: URLSearchParams,
    form: URLSearchParams,
    authed: boolean,
  ): Promise<Response> => {
    if (method === "POST" && path === "/auth/ad/callback") {
      if (!form.get("hash")) return fail(422, "hash is required");
      const iat = Math.floor(now() / 1000);
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({ user_id: 100_001, email, iat, exp: iat + JWT_LIFETIME_S }),
      );
      return ok({ token: `${header}.${payload}.fake` });
    }
    if (!authed) return Response.json({ message: "Unauthorized" }, { status: 402 });

    settle();
    if (method === "GET" && path === "/me") {
      return ok({
        room_id: 4141,
        user_id: 100_001,
        residence_id: "U0000000X",
        firstname: "Fake",
        lastname: "Resident",
        email,
        balance: state.balance,
        notification: 0,
        aircon: {
          id: 4242,
          aircon_code: state.aircon_code,
          aircon_type: 1,
          status: true,
          current_temperature: state.power ? state.setpoint : 28,
          power: state.power,
          mode: state.mode,
          maintenance_mode: 0,
          comm_stat: 1,
          default_account: 100_001,
          setpoint: state.setpoint,
          flap: state.flap,
          fanstep: state.fanstep,
          hall: { hall_name: "Hall 11" },
          room: { room_name: state.aircon_code.replace(/-\d+$/, ""), id: 4141 },
        },
      });
    }
    if (method === "POST" && path === "/v2/ac/control") {
      const change: Control = {};
      const power = form.get("power");
      if (power !== null) {
        if (power !== "0" && power !== "1") return fail(422, "power must be 0 or 1");
        change.power = Number(power) as 0 | 1;
      }
      const setpoint = form.get("setpoint");
      if (setpoint !== null) {
        if (!/^\d{1,2}$/.test(setpoint)) return fail(422, "setpoint must be a number");
        // The hall controller ignores anything below 22 (ENDPOINTS 2.2).
        change.setpoint = Math.max(22, Number(setpoint));
      }
      const mode = form.get("mode");
      if (mode !== null) {
        if (!MODES.includes(mode)) return fail(422, "unknown mode");
        change.mode = mode as Control["mode"];
      }
      const fanstep = form.get("fanstep");
      if (fanstep !== null) {
        if (!FANS.includes(fanstep)) return fail(422, "unknown fanstep");
        change.fanstep = fanstep as Control["fanstep"];
      }
      const flap = form.get("flap");
      if (flap !== null) {
        if (flap !== "N" && flap !== "S") return fail(422, "unknown flap");
        change.flap = flap;
      }
      pending.push({ at: now() + APPLY_DELAY_MS, change });
      return Response.json({
        meta: { status: 200, message: "Successfully control aircon." },
      });
    }
    if (method === "GET" && path === "/usage/history") return paged(usageRows(), q);
    if (method === "GET" && path === "/topup/history") {
      const rows = [10, 20].map((amount, i) => ({
        type: i ? "VisaMaster" : "PayNow",
        created_on: sgt(now() - (i + 1) * 7 * DAY_MS),
        id: 754_401 - i,
        user_id: 100_001,
        status: 1,
        amount,
        txn_id: `INV-000075440${1 - i}`,
      }));
      return paged(rows, q);
    }
    if (method === "GET" && path === "/notification") {
      const rows = [
        {
          send_on: sgt(now() - DAY_MS),
          id: 2_385_442,
          user_id: 100_001,
          title: "Aircon Switched On via Remote",
          message: `Dear Resident, ${state.aircon_code} has just been turned on via remote.`,
          status: false,
        },
        {
          send_on: sgt(now() - 2 * DAY_MS),
          id: 2_385_441,
          user_id: 100_001,
          title: "Low Balance",
          message: "Your wallet balance is below $3. Please top up.",
          status: true,
        },
      ];
      return paged(rows, q);
    }
    if (method === "GET" && path.startsWith("/app-config/")) {
      const data = config(decodeURIComponent(path.slice("/app-config/".length)));
      return data === undefined ? fail(404, "Not found") : ok(data);
    }
    if (method === "GET" && path === "/faq") {
      return ok([
        { question: "How much does the aircon cost?", answer: "S$0.39 per hour." },
        {
          question: "When does the aircon switch off?",
          answer: "Daikin's hall system switches every aircon off at 11:00 daily.",
        },
      ]);
    }
    if (method === "POST" && (path === "/ac/pair" || path === "/ac/default")) {
      const code = form.get("code");
      if (!code) return fail(422, "code is required");
      if (path === "/ac/pair") state.aircon_code = code;
      return Response.json({ meta: { status: 200 } });
    }
    if (method === "POST" && path === "/topup") {
      const amount = Number(form.get("amount"));
      const type = form.get("type");
      if (!AMOUNTS.includes(amount)) return fail(422, "Allowed amount: 10,20,30,40,50");
      if (type === "PayNow") return ok({ qrcode: `data:image/png;base64,${PNG_1X1}` });
      if (type === "VisaMaster") return ok({ payment_url: PAYMENT_URL });
      return fail(422, "Allowed type: PayNow,VisaMaster");
    }
    return fail(404, "Not found");
  };

  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== DAIKIN_BASE) return fail(404, "Not found");
    // arrayBuffer, not text(): workerd warns about .text() on a urlencoded body.
    const body = req.method === "GET" ? "" : new TextDecoder().decode(await req.arrayBuffer());
    const bearer = /^Bearer\s+\S+/.test(req.headers.get("Authorization") ?? "");
    return route(req.method, url.pathname, url.searchParams, new URLSearchParams(body), bearer);
  };
}
