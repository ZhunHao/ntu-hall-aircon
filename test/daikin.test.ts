import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { Daikin, DaikinError, DaikinExpired, jwtClaims } from "../src/do/daikin";
import type { Me } from "../src/do/daikin";
import { DAIKIN, daikin, fakeJwt, meBody } from "./fixtures/daikin";
import { network } from "./network";

/** `.text()` on a urlencoded body makes workerd print a warning, so decode the bytes. */
const bodyText = async (r: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> =>
  new TextDecoder().decode(await r.arrayBuffer());

const JWT = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });

describe("Daikin client", () => {
  it("me() sends the Dart UA and Bearer header and returns data", async () => {
    let headers: Headers | undefined;
    network.use(
      http.get(`${DAIKIN}/me`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json(meBody());
      }),
    );
    const me: Me = await new Daikin(JWT).me();
    expect(headers?.get("user-agent")).toBe("Dart/3.0 (dart:io)");
    expect(headers?.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(headers?.get("cookie")).toBeNull();
    expect(me.email).toBe("ABC123@e.ntu.edu.sg");
    expect(me.aircon?.aircon_code).toBe("H11-12-34-5678-01");
  });

  it("control() posts only the given fields as a form body", async () => {
    let body = "";
    let type: string | null = null;
    network.use(
      http.post(`${DAIKIN}/v2/ac/control`, async ({ request }) => {
        body = await bodyText(request);
        type = request.headers.get("content-type");
        return HttpResponse.json({ meta: { status: 200 } });
      }),
    );
    await new Daikin(JWT).control({ power: 1, setpoint: 23 });
    expect(body).toBe("power=1&setpoint=23");
    expect(type).toContain("application/x-www-form-urlencoded");
  });

  it("402 throws DaikinExpired", async () => {
    network.use(
      http.get(`${DAIKIN}/me`, () => HttpResponse.json({ message: "Unauthorized" }, { status: 402 })),
    );
    await expect(new Daikin(JWT).me()).rejects.toBeInstanceOf(DaikinExpired);
  });

  it("500 throws DaikinError with the status", async () => {
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.json({ message: "boom" }, { status: 500 })));
    await expect(new Daikin(JWT).me()).rejects.toMatchObject({ status: 500 });
    await expect(new Daikin(JWT).me()).rejects.toBeInstanceOf(DaikinError);
  });

  it("a 200 with an HTML body throws DaikinError (Review Focus 5)", async () => {
    network.use(
      http.get(`${DAIKIN}/me`, () => new HttpResponse("<html>oops</html>", { headers: { "content-type": "text/html" } })),
    );
    await expect(new Daikin(JWT).me()).rejects.toBeInstanceOf(DaikinError);
  });

  it("a 200 with an empty body throws DaikinError", async () => {
    network.use(http.post(`${DAIKIN}/v2/ac/control`, () => new HttpResponse(null, { status: 200 })));
    await expect(new Daikin(JWT).control({ power: 0 })).rejects.toBeInstanceOf(DaikinError);
  });

  it("a network failure throws DaikinError and never leaks the token", async () => {
    network.use(http.get(`${DAIKIN}/me`, () => HttpResponse.error()));
    const err = await new Daikin(JWT).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaikinError);
    expect((err as Error).message).not.toContain(JWT);
  });

  it("error messages never include the JWT or payment URL", async () => {
    network.use(
      http.get(`${DAIKIN}/me`, () => HttpResponse.json({ message: "bad" }, { status: 503 })),
    );
    const err = (await new Daikin(JWT).me().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(JWT);
    expect(err.message).not.toContain("daikinpayu");
  });

  it("times out a stalled response", async () => {
    network.use(http.get(`${DAIKIN}/me`, async () => { await delay("infinite"); return HttpResponse.json(meBody()); }));
    const err = await new Daikin(JWT, undefined, 50).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaikinError);
    expect(err).toMatchObject({ status: 0, message: "Daikin timed out" });
  });

  it("times out a fetcher that ignores the abort signal", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    await expect(new Daikin(JWT, hang, 50).me()).rejects.toMatchObject({ status: 0, message: "Daikin timed out" });
  });

  it("times out a stalled body read", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    await expect(new Daikin(JWT, stalled, 50).me()).rejects.toMatchObject({ status: 0, message: "Daikin timed out" });
  });

  it("does not forward set-cookie or send cookies", async () => {
    let cookie: string | null = "unset";
    network.use(
      http.get(`${DAIKIN}/me`, ({ request }) => {
        cookie = request.headers.get("cookie");
        return HttpResponse.json(meBody(), { headers: { "set-cookie": "connect.sid=abc; Path=/" } });
      }),
    );
    const d = new Daikin(JWT);
    await d.me();
    await d.me();
    expect(cookie).toBeNull();
  });

  it("exchange() posts hash and fcm_token without Authorization and returns the token", async () => {
    let body = "";
    let auth: string | null = "unset";
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, async ({ request }) => {
        body = await bodyText(request);
        auth = request.headers.get("authorization");
        return HttpResponse.json({ meta: { status: 200 }, data: { token: JWT } });
      }),
    );
    expect(await new Daikin(null).exchange("HASH123")).toBe(JWT);
    expect(body).toBe("hash=HASH123&fcm_token=placeholder");
    expect(auth).toBeNull();
  });

  it("exchange() without a token in the reply throws DaikinError", async () => {
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ meta: { status: 200 }, data: {} })),
    );
    await expect(new Daikin(null).exchange("HASH123")).rejects.toBeInstanceOf(DaikinError);
  });

  it("usage() sends limit/offset and reads the total from meta.rowCount", async () => {
    let search = "";
    const row = { starttime: "a", endtime: null, duration: 11, amount: 0.07 };
    network.use(
      http.get(`${DAIKIN}/usage/history`, ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ meta: { rowCount: 1524 }, data: [row] });
      }),
    );
    expect(await new Daikin(JWT).usage(5, 10)).toEqual({ rows: [row], total: 1524 });
    expect(search).toBe("?limit=5&offset=10");
  });

  it("topups, notifications, config, faq, pair, makeDefault and topup use the documented requests", async () => {
    const seen: string[] = [];
    network.use(
      http.all(`${DAIKIN}/*`, async ({ request }) => {
        const u = new URL(request.url);
        seen.push(`${request.method} ${u.pathname}${u.search} ${await bodyText(request)}`);
        return HttpResponse.json({ meta: { status: 200 }, data: { qrcode: "data:image/png;base64,AA==", other: 1 } });
      }),
    );
    const d = new Daikin(JWT);
    await d.topups(20, 0);
    await d.notifications(20, 40);
    await d.config("temperature_allowed_min");
    await d.faq();
    await d.pair("H11-12-34-5678-01");
    await d.makeDefault("H11-12-34-5678-01");
    expect(await d.topup(10, "PayNow")).toEqual({ qrcode: "data:image/png;base64,AA==" });
    expect(seen).toEqual([
      "GET /topup/history?limit=20&offset=0 ",
      "GET /notification?limit=20&offset=40 ",
      "GET /app-config/temperature_allowed_min ",
      "GET /faq ",
      "POST /ac/pair code=H11-12-34-5678-01",
      "POST /ac/default code=H11-12-34-5678-01",
      "POST /topup amount=10&type=PayNow",
    ]);
  });

  it("works with the shared default handlers", async () => {
    network.use(...daikin);
    expect((await new Daikin(JWT).me()).balance).toBe(10);
  });
});

describe("jwtClaims", () => {
  it("returns email and exp from the payload", () => {
    expect(jwtClaims(fakeJwt({ email: "ABC123@e.ntu.edu.sg", exp: 1800000000 }))).toEqual({
      email: "ABC123@e.ntu.edu.sg",
      exp: 1800000000,
    });
  });

  it("rejects malformed tokens", () => {
    expect(() => jwtClaims("nope")).toThrow("bad-jwt");
    expect(() => jwtClaims("a.!!!.c")).toThrow("bad-jwt");
    expect(() => jwtClaims(`a.${btoa(JSON.stringify({ email: 1 }))}.c`)).toThrow("bad-jwt");
  });
});
