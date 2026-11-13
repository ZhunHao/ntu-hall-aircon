import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { Home } from "../src/do/home";
import { DAIKIN, fakeJwt, meBody, meData } from "./fixtures/daikin";
import { network } from "./network";

const CODE = "A".repeat(24);
const IP = "203.0.113.7";
let n = 0;

/** A Home that is signed in through the mocked callback. Returns its stub. */
async function signedIn() {
  const jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });
  network.use(
    http.post(`${DAIKIN}/auth/ad/callback`, () =>
      HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } }),
    ),
  );
  const stub = env.HOME.getByName(`proxy-${++n}`);
  const r = await stub.signIn(CODE, IP);
  expect(r.ok).toBe(true);
  return { stub, token: r.ok ? r.token : "" };
}

/** Count and body-capture for a Daikin route. */
function spy(method: "get" | "post", path: string, reply: () => Response) {
  const seen = { calls: 0, bodies: [] as string[], urls: [] as string[] };
  network.use(
    http[method](`${DAIKIN}${path}`, async ({ request }) => {
      seen.calls++;
      seen.urls.push(request.url);
      seen.bodies.push(new TextDecoder().decode(await request.arrayBuffer()));
      return reply();
    }),
  );
  return seen;
}

const ok = (data: unknown, meta: Record<string, unknown> = { status: 200 }) =>
  HttpResponse.json({ meta, data });

const isExpired = async (stub: ReturnType<typeof env.HOME.getByName>) =>
  runInDurableObject(stub, (_h: Home, state) => {
    const r = state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'expired'").toArray();
    return r[0] ? JSON.parse(r[0].value) === true : false;
  });

describe("control", () => {
  it("rejects a setpoint outside 22-26 with 400 and no outbound call", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/v2/ac/control", () => ok({}));
    for (const setpoint of [27, 21, 22.5, "24", null, Number.NaN]) {
      expect(await stub.control({ setpoint })).toMatchObject({ ok: false, status: 400 });
    }
    expect(s.calls).toBe(0);
  });

  it("rejects bad mode, fan, power and flap, unknown keys and an empty object", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/v2/ac/control", () => ok({}));
    const bads: unknown[] = [
      { mode: "X" },
      { mode: "c" },
      { fanstep: "X" },
      { fanstep: 3 },
      { power: 2 },
      { power: "1" },
      { flap: "X" },
      { setpoint: 24, mode: "bogus" },
      { setpoint: 24, extra: 1 },
      { setpoint: 24, __proto__x: 1 },
      {},
      null,
      [],
      "setpoint",
      { setpoint: undefined },
    ];
    for (const c of bads) expect(await stub.control(c)).toMatchObject({ ok: false, status: 400 });
    expect(s.calls).toBe(0);
  });

  it("sends only validated fields", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/v2/ac/control", () => ok({}));
    const r = await stub.control({ power: 1, setpoint: 24, mode: "D", fanstep: "MH", flap: "S" });
    expect(r).toEqual({ ok: true, data: null });
    expect(s.calls).toBe(1);
    const form = new URLSearchParams(s.bodies[0]);
    expect(Object.fromEntries(form)).toEqual({ power: "1", setpoint: "24", mode: "D", fanstep: "MH", flap: "S" });
  });

  it("maps a Daikin 402 to 401 expired", async () => {
    const { stub } = await signedIn();
    network.use(http.post(`${DAIKIN}/v2/ac/control`, () => new HttpResponse(null, { status: 402 })));
    expect(await stub.control({ power: 0 })).toEqual({ ok: false, status: 401, error: "expired" });
  });
});

describe("me", () => {
  it("a 402 upstream gives 401 and session() reports expired", async () => {
    const { stub, token } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => new HttpResponse(null, { status: 402 })));
    expect(await stub.me()).toEqual({ ok: false, status: 401, error: "expired" });
    expect(await isExpired(stub)).toBe(true);
    const hash = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(token))
      .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
    expect(await stub.session(hash)).toMatchObject({ valid: true, expired: true });
  });

  it("after expiry no further Daikin call is made", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => new HttpResponse(null, { status: 402 })));
    await stub.me();
    const s = spy("get", "/me", () => HttpResponse.json(meBody()));
    expect(await stub.me()).toMatchObject({ ok: false, status: 401 });
    expect(s.calls).toBe(0);
  });

  it("returns a projection, not Daikin's raw data", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json(meBody())));
    const r = await stub.me();
    expect(r).toEqual({
      ok: true,
      data: {
        email: "ABC123@e.ntu.edu.sg",
        firstname: "Tan",
        balance: 10,
        aircon: {
          power: 0,
          setpoint: 22,
          mode: "C",
          fanstep: "A",
          flap: "N",
          comm_stat: 1,
          maintenance_mode: 0,
          aircon_code: "H11-12-34-5678-01",
          current_temperature: 26,
          room: { room_name: "H11-12-34-5678" },
          default_account: true,
        },
      },
    });
    const text = JSON.stringify(r);
    for (const secret of ["residence_id", "U0000000X", "user_id", "100001", "wallet", "lastname", "4141"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports default_account false when another account holds the room", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json(meBody({ default_account: 999 }))));
    const r = await stub.me();
    expect(r.ok && r.data.aircon?.default_account).toBe(false);
  });

  it("passes a missing or non-numeric room temperature through as null", async () => {
    const { stub } = await signedIn();
    for (const t of [null, undefined, "26"]) {
      network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json(meBody({ current_temperature: t as unknown as number }))));
      const r = await stub.me();
      expect(r.ok && r.data.aircon?.current_temperature).toBeNull();
    }
  });

  it("passes an unpaired resident through as aircon null", async () => {
    const { stub } = await signedIn();
    network.use(
      http.get(`${DAIKIN}/me`, () => HttpResponse.json({ meta: {}, data: { ...meData(), aircon: null } })),
    );
    const r = await stub.me();
    expect(r).toMatchObject({ ok: true, data: { aircon: null, balance: 10 } });
  });

  it("an empty 200 body is a 502, not a crash", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => new HttpResponse("", { status: 200 })));
    expect(await stub.me()).toEqual({ ok: false, status: 502, error: "daikin" });
  });

  it("an HTML body and a malformed profile are 502 too", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => new HttpResponse("<html></html>", { status: 200 })));
    expect(await stub.me()).toMatchObject({ ok: false, status: 502 });
    network.use(http.get(`${DAIKIN}/me`, () => ok({ email: "x" })));
    expect(await stub.me()).toMatchObject({ ok: false, status: 502 });
  });

  it("is a 401 when signed out", async () => {
    const stub = env.HOME.getByName(`proxy-out-${++n}`);
    expect(await stub.me()).toEqual({ ok: false, status: 401, error: "expired" });
  });
});

describe("paging", () => {
  let stub: Awaited<ReturnType<typeof signedIn>>["stub"];
  beforeEach(async () => {
    stub = (await signedIn()).stub;
  });

  it("rejects limit and offset out of range with no outbound call", async () => {
    const s = spy("get", "/usage/history", () => ok([]));
    spy("get", "/topup/history", () => ok([]));
    spy("get", "/notification", () => ok([]));
    const pages: [unknown, unknown][] = [
      [0, 0], [51, 0], [-1, 0], [10, -1], [1.5, 0], [10, 0.5], ["10", 0], [10, "0"], [Number.NaN, 0], [10, Number.POSITIVE_INFINITY],
    ];
    for (const [l, o] of pages) {
      const [a, b] = [l, o] as [number, number]; // deliberately wrong types at runtime
      expect(await stub.usage(a, b)).toMatchObject({ ok: false, status: 400 });
      expect(await stub.topups(a, b)).toMatchObject({ ok: false, status: 400 });
      expect(await stub.notifications(a, b)).toMatchObject({ ok: false, status: 400 });
    }
    expect(s.calls).toBe(0);
  });

  const USAGE_RAW = {
    starttime: "a", endtime: null, duration: 1, amount: 0.1,
    id: 10000380, aircon_id: 4242, user_id: 100001, rate: 0.0065, aircon_name: "H11-12-34-5678-01", activate_type: 1,
  };
  const TOPUP_RAW = {
    type: "PayNow", created_on: "2026-10-28T22:25:29.000+08:00", id: 500401, user_id: 100001,
    firstname: "Tan", lastname: "Ah Kow", email: "ABC123@e.ntu.edu.sg", status: 1, amount: 10,
    txn_id: "INV-0000500401", txn_ref: "26102800000000000001", is_queried: false,
  };
  const NOTE_RAW = {
    send_on: "2026-10-19T04:16:00.000+08:00", id: 2000442, user_id: 100001,
    title: "Aircon Switched On via Remote", message: "Dear Resident", status: false,
  };
  const PRIVATE = ["user_id", "100001", "aircon_id", "rate", "aircon_name", "H11-12", "firstname", "lastname", "Tan", "email", "ABC123", "txn_id", "txn_ref", "INV-", "is_queried", "activate_type", "2000442", "500401", "10000380"];
  const clean = (r: unknown) => {
    const text = JSON.stringify(r);
    for (const p of PRIVATE) expect(text).not.toContain(p);
  };

  it("usage passes limit/offset and returns projected rows with the total", async () => {
    const s = spy("get", "/usage/history", () => ok([USAGE_RAW, "junk", null], { status: 200, rowCount: 7 }));
    const r = await stub.usage(50, 5);
    expect(r).toEqual({ ok: true, data: { rows: [{ starttime: "a", endtime: null, duration: 1, amount: 0.1 }], total: 7 } });
    clean(r);
    expect(new URL(s.urls[0]).searchParams.get("limit")).toBe("50");
    expect(new URL(s.urls[0]).searchParams.get("offset")).toBe("5");
  });

  it("topups returns only type, created_on, amount and status", async () => {
    spy("get", "/topup/history", () => ok([TOPUP_RAW]));
    const r = await stub.topups(10, 0);
    expect(r).toEqual({
      ok: true,
      data: [{ type: "PayNow", created_on: "2026-10-28T22:25:29.000+08:00", amount: 10, status: 1 }],
    });
    clean(r);
  });

  it("notifications return only title, message, send_on and status, with text coerced to strings", async () => {
    spy("get", "/notification", () => ok([NOTE_RAW, { ...NOTE_RAW, title: 5, message: null, send_on: undefined, status: "yes" }]));
    const r = await stub.notifications(10, 0);
    expect(r).toEqual({
      ok: true,
      data: [
        { title: "Aircon Switched On via Remote", message: "Dear Resident", send_on: "2026-10-19T04:16:00.000+08:00", status: false },
        { title: "", message: "", send_on: "", status: false },
      ],
    });
    clean(r);
  });

  it("a non-list history body is a 502", async () => {
    spy("get", "/topup/history", () => ok({ rows: [] }));
    spy("get", "/notification", () => ok("nope"));
    expect(await stub.topups(10, 0)).toMatchObject({ ok: false, status: 502 });
    expect(await stub.notifications(10, 0)).toMatchObject({ ok: false, status: 502 });
  });

  it("maps a Daikin 500 to 502", async () => {
    network.use(http.get(`${DAIKIN}/usage/history`, () => HttpResponse.json({ meta: {} }, { status: 500 })));
    expect(await stub.usage(10, 0)).toEqual({ ok: false, status: 502, error: "daikin" });
  });
});

describe("config", () => {
  const mockConfig = (amounts: unknown = [
    { amount: 10, enable: true },
    { amount: 20, enable: false },
    { amount: 50, enable: true },
  ]) => {
    network.use(
      http.get(`${DAIKIN}/app-config/temperature_allowed_min`, () => ok({ value: 22 })),
      http.get(`${DAIKIN}/app-config/temperature_allowed_max`, () => ok({ value: "26" })),
      http.get(`${DAIKIN}/app-config/payment_dominations`, () => ok({ value: amounts })),
      http.get(`${DAIKIN}/faq`, () => ok([{ question: "Q", answer: "A" }])),
    );
  };

  it("combines limits, enabled amounts and the faq", async () => {
    const { stub } = await signedIn();
    mockConfig();
    expect(await stub.config()).toEqual({
      ok: true,
      data: { tempMin: 22, tempMax: 26, amounts: [10, 50], faq: [{ question: "Q", answer: "A" }] },
    });
  });

  it("an unexpected shape is a 502", async () => {
    const { stub } = await signedIn();
    mockConfig("nope");
    expect(await stub.config()).toMatchObject({ ok: false, status: 502 });
  });
});

describe("pair", () => {
  it("rejects codes that do not match, with no outbound call", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/ac/pair", () => ok({}));
    for (const code of ["", "H11-12-34-5678", "h11-12-34-5678-01", "H11-12-34-5678-01\n", "X11-12-34-5678-01", "H11-2-34-5678-01", " H11-12-34-5678-01"]) {
      expect(await stub.pair(code)).toMatchObject({ ok: false, status: 400 });
    }
    expect(await stub.pair(5 as unknown as string)).toMatchObject({ ok: false, status: 400 });
    expect(s.calls).toBe(0);
  });

  it("posts a valid code", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/ac/pair", () => ok({}));
    expect(await stub.pair("H11-12-34-5678-01")).toEqual({ ok: true, data: null });
    expect(new URLSearchParams(s.bodies[0]).get("code")).toBe("H11-12-34-5678-01");
  });
});

describe("roomAccount", () => {
  it("posts the code from /me, not from the client", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json(meBody())));
    const s = spy("post", "/ac/default", () => ok({}));
    expect(await stub.roomAccount()).toEqual({ ok: true, data: null });
    expect(s.calls).toBe(1);
    expect(s.bodies[0]).toBe("code=H11-12-34-5678-01");
  });

  it("is 400 not-paired when /me has no aircon, with no /ac/default call", async () => {
    const { stub } = await signedIn();
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json({ meta: {}, data: { ...meData(), aircon: null } })));
    const s = spy("post", "/ac/default", () => ok({}));
    expect(await stub.roomAccount()).toEqual({ ok: false, status: 400, error: "not-paired" });
    expect(s.calls).toBe(0);
  });
});

describe("topup", () => {
  it("rejects an amount outside the list or a bad type with no outbound call", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/topup", () => ok({}));
    expect(await stub.topup(15, "PayNow")).toMatchObject({ ok: false, status: 400 });
    expect(await stub.topup(0, "PayNow")).toMatchObject({ ok: false, status: 400 });
    expect(await stub.topup(10, "Bitcoin")).toMatchObject({ ok: false, status: 400 });
    expect(await stub.topup("10" as unknown as number, "PayNow")).toMatchObject({ ok: false, status: 400 });
    expect(s.calls).toBe(0);
  });

  it("returns only qrcode and payment_url", async () => {
    const { stub } = await signedIn();
    const s = spy("post", "/topup", () =>
      ok({ qrcode: "data:image/png;base64,AAA", payment_url: "https://pay.example/x", user_id: 1, secret: "s" }),
    );
    const r = await stub.topup(20, "PayNow");
    expect(r).toEqual({ ok: true, data: { qrcode: "data:image/png;base64,AAA", payment_url: "https://pay.example/x" } });
    expect(Object.fromEntries(new URLSearchParams(s.bodies[0]))).toEqual({ amount: "20", type: "PayNow" });
  });
});
