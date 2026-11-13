import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Home } from "../src/do/home";
import worker, { type Env } from "../src/worker/index";
import { DAIKIN, daikin, fakeJwt } from "./fixtures/daikin";
import { network } from "./network";

const ORIGIN = "https://x.test";
const CODE = "A".repeat(24); // extractCode accepts a bare token of 16+ base64 chars
const JSON_HEADERS = { "Content-Type": "application/json", Origin: ORIGIN };

let ipCounter = 0;
/** A fresh client address per call, so the per-IP sign-in limit never couples tests. */
const freshIp = () => `198.51.100.${++ipCounter}`;

function mockCallback(jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" })): { calls: number } {
  const seen = { calls: 0 };
  network.use(
    http.post(`${DAIKIN}/auth/ad/callback`, async ({ request }) => {
      seen.calls++;
      await request.arrayBuffer();
      return HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } });
    }),
  );
  return seen;
}

const req = (path: string, init: RequestInit & { origin?: string } = {}): Request => {
  const { origin = ORIGIN, ...rest } = init;
  return new Request(`${origin}${path}`, rest);
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}, origin = ORIGIN) =>
  req(path, {
    method: "POST",
    origin,
    headers: { ...JSON_HEADERS, Origin: origin, ...headers },
    body: JSON.stringify(body),
  });

/** Call the default export with a modified env, like a differently configured deployment. */
const withEnv = (r: Request, over: Partial<Env>): Promise<Response> =>
  worker.fetch(r, { ...env, ...over }, createExecutionContext());

const cookieOf = (r: Response): string => {
  const sc = r.headers.get("Set-Cookie") ?? "";
  const m = /^ha_session=([^;]+)/.exec(sc);
  if (!m) throw new Error("no session cookie");
  return m[1]!;
};

/** Sign in as the owner and return the cookie header value. */
async function signIn(): Promise<string> {
  mockCallback();
  const r = await exports.default.fetch(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }));
  expect(r.status).toBe(200);
  return `ha_session=${cookieOf(r)}`;
}

const authed = (path: string, cookie: string, init: RequestInit = {}) =>
  exports.default.fetch(req(path, { ...init, headers: { Cookie: cookie, ...init.headers } }));

describe("/api headers and routing", () => {
  it("answers unknown routes 404 before any session check (R1)", async () => {
    const r = await exports.default.fetch(req("/api/nope"));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not-found" });
    expect((await exports.default.fetch(req("/api/constructor"))).status).toBe(404);
  });

  it("answers a wrong method on a known route 405", async () => {
    const r = await exports.default.fetch(req("/api/control"));
    expect(r.status).toBe(405);
    expect(await r.json()).toEqual({ error: "method" });
    expect((await exports.default.fetch(post("/api/me", {}))).status).toBe(405);
  });

  it("puts the security headers on every /api response, errors included", async () => {
    for (const r of [await exports.default.fetch(req("/api/me")), await exports.default.fetch(req("/api/nope"))]) {
      expect(r.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("hands everything outside /api to the assets binding untouched", async () => {
    const seen: string[] = [];
    const ASSETS = {
      fetch: async (r: Request) => {
        seen.push(new URL(r.url).pathname);
        return new Response("page");
      },
    } as unknown as Fetcher;
    const r = await withEnv(req("/index.html"), { ASSETS });
    expect(await r.text()).toBe("page");
    expect(seen).toEqual(["/index.html"]);
    expect(r.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("session", () => {
  it("rejects /api/me without a cookie", async () => {
    const r = await exports.default.fetch(req("/api/me"));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "signed-out" });
  });

  it("rejects an empty or unknown cookie", async () => {
    expect((await authed("/api/me", "ha_session=")).status).toBe(401);
    expect((await authed("/api/me", "ha_session=not-a-token")).status).toBe(401);
    // Well-shaped but never issued: the Durable Object says no.
    expect((await authed("/api/me", `ha_session=${"a".repeat(43)}`)).status).toBe(401);
  });

  it("sign-in sets an HttpOnly Secure SameSite=Strict cookie, never returns the token, and /api/me then works", async () => {
    network.use(...daikin);
    const cookie = await signIn();
    // signIn() registered its own callback; /me needs the default handlers again.
    network.use(...daikin);

    const r = await authed("/api/me", cookie);
    expect(r.status).toBe(200);
    const me = (await r.json()) as { email: string; aircon: { aircon_code: string } };
    expect(me.email).toBe("ABC123@e.ntu.edu.sg");
    expect(me.aircon.aircon_code).toBe("H11-12-34-5678-01");
  });

  it("sets the cookie flags and a Max-Age that follows the JWT", async () => {
    mockCallback();
    const r = await exports.default.fetch(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }));
    const sc = r.headers.get("Set-Cookie") ?? "";
    expect(sc).toMatch(/^ha_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=\d+$/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(sc)![1]);
    expect(maxAge).toBeGreaterThan(86_400 - 60);
    expect(maxAge).toBeLessThanOrEqual(86_400);

    const body = (await r.json()) as { ok: boolean; expiresMs: number };
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["expiresMs", "ok"]);
    expect(JSON.stringify(body)).not.toContain(cookieOf(r));
  });

  it("/api/session: valid with a session, email only then (S3)", async () => {
    const cookie = await signIn();
    const ok = (await (await authed("/api/session", cookie)).json()) as Record<string, unknown>;
    expect(ok.valid).toBe(true);
    expect(ok.email).toBe("ABC123@e.ntu.edu.sg");
    expect(typeof ok.expiresMs).toBe("number");

    const none = await exports.default.fetch(req("/api/session"));
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ valid: false });

    const bad = (await (await authed("/api/session", "ha_session=forged")).json()) as Record<string, unknown>;
    expect(bad).toEqual({ valid: false });
    expect("email" in bad).toBe(false);
    const unknown = await authed("/api/session", `ha_session=${"a".repeat(43)}`);
    expect(await unknown.json()).toEqual({ valid: false });
  });

  it("sign-out clears the cookie with Max-Age=0 and ends the session", async () => {
    const cookie = await signIn();
    const r = await authed("/api/signout", cookie, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(r.status).toBe(200);
    expect(r.headers.get("Set-Cookie")).toBe("ha_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    expect((await authed("/api/me", cookie)).status).toBe(401);
  });

  it("sign-out needs a session, so a stranger cannot stop the schedule", async () => {
    const r = await exports.default.fetch(post("/api/signout", {}));
    expect(r.status).toBe(401);
    expect(r.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("sign-in", () => {
  it("needs a {text: string} body", async () => {
    for (const body of [{}, { text: 5 }, { text: null }, [], "x"]) {
      const r = await exports.default.fetch(post("/api/signin", body, { "CF-Connecting-IP": freshIp() }));
      expect(r.status).toBe(400);
    }
    const empty = await exports.default.fetch(
      req("/api/signin", { method: "POST", headers: JSON_HEADERS, body: "{not json" }),
    );
    expect(empty.status).toBe(400);
  });

  it("rejects text over 4096 characters", async () => {
    const r = await exports.default.fetch(
      post("/api/signin", { text: "a".repeat(4097) }, { "CF-Connecting-IP": freshIp() }),
    );
    expect(r.status).toBe(400);
  });

  it("maps Home errors: no-code 400, not-owner 400, rate-limited 429", async () => {
    const noCode = await exports.default.fetch(post("/api/signin", { text: "nothing here" }, { "CF-Connecting-IP": freshIp() }));
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toEqual({ error: "no-code" });

    mockCallback(fakeJwt({ email: "someone-else@e.ntu.edu.sg" }));
    const other = await exports.default.fetch(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }));
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: "not-owner" });
    expect(other.headers.get("Set-Cookie")).toBeNull();

    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await exports.default.fetch(post("/api/signin", { text: "nothing" }, { "CF-Connecting-IP": ip }))).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("answers 500 not-configured for each bad config (S4)", async () => {
    // The Durable Object reads its own env, so vary that one (as the Home tests do).
    const home = env.HOME.getByName("home");
    for (const over of [{ OWNER_EMAIL: "" }, { OWNER_EMAIL: "your-id@e.ntu.edu.sg" }, { SESSION_SECRET: "abc" }]) {
      await runInDurableObject(home, (h: Home) => {
        (h as unknown as { env: Env }).env = { ...env, ...over };
      });
      try {
        const r = await exports.default.fetch(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }));
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: "not-configured" });
      } finally {
        await runInDurableObject(home, (h: Home) => {
          (h as unknown as { env: Env }).env = env;
        });
      }
    }
  });
});

describe("CSRF", () => {
  it("rejects a foreign Origin", async () => {
    const cookie = await signIn();
    const r = await authed("/api/control", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify({ power: 1 }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "bad-origin" });
  });

  it("rejects a missing Origin and a missing or wrong Content-Type", async () => {
    const cookie = await signIn();
    const noOrigin = await authed("/api/control", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noOrigin.status).toBe(403);
    const noType = await authed("/api/control", cookie, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
    expect(noType.status).toBe(403);
    expect(await noType.json()).toEqual({ error: "bad-origin" });
    const formType = await authed("/api/control", cookie, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(formType.status).toBe(403);
  });

  it("accepts application/json with a charset", async () => {
    network.use(...daikin);
    const cookie = await signIn();
    network.use(...daikin);
    const r = await authed("/api/control", cookie, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ power: 1 }),
    });
    expect(r.status).toBe(200);
  });

  it("checks CSRF before the session, so a foreign Origin is 403 even when signed out", async () => {
    const bad = await exports.default.fetch(
      req("/api/control", { method: "POST", headers: { ...JSON_HEADERS, Origin: "https://evil.test" }, body: "{}" }),
    );
    expect(bad.status).toBe(403);
    const good = await exports.default.fetch(post("/api/control", { power: 1 }));
    expect(good.status).toBe(401);
  });
});

describe("body size (S1)", () => {
  it("rejects a 10 KB sign-in with 413 by Content-Length", async () => {
    const r = await exports.default.fetch(post("/api/signin", { text: "a".repeat(10_240) }, { "CF-Connecting-IP": freshIp() }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "too-large" });
  });

  it("rejects a body whose real size exceeds the limit even when Content-Length is absent", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ text: "a".repeat(10_240) }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big.slice(0, 4096));
        c.enqueue(big.slice(4096));
        c.close();
      },
    });
    const r = await exports.default.fetch(
      new Request(`${ORIGIN}/api/signin`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(r.status).toBe(413);
  });

  it("lets a body just under 8 KB past the size check", async () => {
    const body = JSON.stringify({ text: "a".repeat(8_000) });
    const r = await exports.default.fetch(
      req("/api/signin", { method: "POST", headers: { ...JSON_HEADERS, "CF-Connecting-IP": freshIp() }, body }),
    );
    // Not 413: it reached the sign-in handler, which refuses text over 4096 characters.
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid" });
  });
});

describe("schedule and paging", () => {
  it("rejects an overlapping schedule with 400 and its problems", async () => {
    const cookie = await signIn();
    const overlap = {
      enabled: true,
      view: "nights",
      periods: [
        { day: 0, start: "22:00", end: "23:30", setpoint: 24, mode: "C", fan: "A" },
        { day: 0, start: "23:00", end: "23:50", setpoint: 24, mode: "C", fan: "A" },
      ],
    };
    const r = await authed("/api/schedule", cookie, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(overlap),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; problems: { code: string }[] };
    expect(body.error).toBe("invalid");
    expect(body.problems.map((p) => p.code)).toContain("overlap");
  });

  it("stores a valid schedule and returns it", async () => {
    const cookie = await signIn();
    const ok = {
      enabled: true,
      view: "nights",
      periods: [{ day: 0, start: "22:00", end: "23:30", setpoint: 24, mode: "C", fan: "A" }],
    };
    const put = await authed("/api/schedule", cookie, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(ok) });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    expect(await (await authed("/api/schedule", cookie)).json()).toEqual(ok);
  });

  it("rejects non-integer paging with 400, and the Durable Object rejects out-of-range values", async () => {
    const cookie = await signIn();
    for (const path of ["usage", "topups", "notifications"]) {
      for (const q of ["limit=abc", "offset=1.5", "limit=", "offset=x"]) {
        const r = await authed(`/api/${path}?${q}`, cookie);
        expect(r.status, `${path}?${q}`).toBe(400);
      }
      expect((await authed(`/api/${path}?limit=500`, cookie)).status).toBe(400);
    }
    expect((await authed("/api/activity?limit=abc", cookie)).status).toBe(400);
  });

  it("serves the activity log with a default limit", async () => {
    const cookie = await signIn();
    const r = await authed("/api/activity", cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it("maps a Home validation error to its status", async () => {
    const cookie = await signIn();
    const r = await authed("/api/control", cookie, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ setpoint: 99 }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid-control" });
    const pair = await authed("/api/pair", cookie, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(pair.status).toBe(400);
  });

  it("maps a Daikin 402 to 401 expired", async () => {
    const cookie = await signIn();
    network.use(http.get(`${DAIKIN}/me`, () => new HttpResponse(null, { status: 402 })));
    const r = await authed("/api/me", cookie);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "expired" });
    const s = (await (await authed("/api/session", cookie)).json()) as { valid: boolean; expired: boolean };
    expect(s).toMatchObject({ valid: true, expired: true });
  });
});

describe("DAIKIN_FAKE only on localhost (S6)", () => {
  it("still calls the real base URL when the host is x.workers.dev", async () => {
    const seen = mockCallback();
    const r = await withEnv(
      post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }, "https://x.workers.dev"),
      { DAIKIN_FAKE: "1" },
    );
    expect(r.status).toBe(200);
    expect(seen.calls).toBe(1);
  });

  it("uses the in-process fake for localhost and never touches the network", async () => {
    const seen = mockCallback();
    for (const host of ["https://localhost", "https://127.0.0.1"]) {
      const r = await withEnv(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }, host), {
        DAIKIN_FAKE: "1",
      });
      expect(r.status, host).toBe(200);
    }
    expect(seen.calls).toBe(0);
  });

  it("ignores DAIKIN_FAKE values other than 1, even on localhost", async () => {
    const seen = mockCallback();
    const r = await withEnv(post("/api/signin", { text: CODE }, { "CF-Connecting-IP": freshIp() }, "https://localhost"), {
      DAIKIN_FAKE: "true",
    });
    expect(r.status).toBe(200);
    expect(seen.calls).toBe(1);
  });
});

describe("Cloudflare Access", () => {
  const AUD = "aud-1234";

  it("rejects with 403 when exactly one Access var is set (S4)", async () => {
    for (const over of [
      { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: AUD },
      { ACCESS_TEAM_DOMAIN: "   ", ACCESS_AUD: AUD },
      // A team domain that is only a scheme or slashes is set but unusable: never serve unprotected.
      { ACCESS_TEAM_DOMAIN: "https://", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "/", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "https:///", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "https://", ACCESS_AUD: AUD },
      { ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/", ACCESS_AUD: "" },
    ]) {
      const r = await withEnv(req("/api/session"), over);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "access-misconfigured" });
    }
  });

  it("rejects with 403 when Access is on and the assertion header is missing or bad", async () => {
    network.use(
      http.get("https://empty.cloudflareaccess.com/cdn-cgi/access/certs", () => HttpResponse.json({ keys: [] })),
    );
    const over = { ACCESS_TEAM_DOMAIN: "empty.cloudflareaccess.com", ACCESS_AUD: AUD };
    const none = await withEnv(req("/api/session"), over);
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "access" });
    const junk = await withEnv(req("/api/session", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }), over);
    expect(junk.status).toBe(403);
  });

  it("lets a request through only with a token signed by the team's key, for this audience and issuer", async () => {
    const team = "ok.cloudflareaccess.com";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    network.use(http.get(`https://${team}/cdn-cgi/access/certs`, () => HttpResponse.json({ keys: [jwk] })));
    const over = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD };

    const sign = (claims: { aud: string; iss: string }, exp = "5m") =>
      new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setAudience(claims.aud).setIssuer(claims.iss).setExpirationTime(exp).sign(privateKey);
    const call = (token: string) =>
      withEnv(req("/api/session", { headers: { "Cf-Access-Jwt-Assertion": token } }), over);

    const good = await call(await sign({ aud: AUD, iss: `https://${team}` }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ valid: false });

    expect((await call(await sign({ aud: "other", iss: `https://${team}` }))).status).toBe(403);
    expect((await call(await sign({ aud: AUD, iss: "https://evil.example" }))).status).toBe(403);
    expect((await call(await sign({ aud: AUD, iss: `https://${team}` }, "-1m"))).status).toBe(403);

    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setAudience(AUD).setIssuer(`https://${team}`).setExpirationTime("5m").sign(other.privateKey);
    expect((await call(forged)).status).toBe(403);
  });

  it("accepts the team domain as Cloudflare shows it: with https:// and a trailing slash", async () => {
    const team = "pasted.cloudflareaccess.com";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    network.use(http.get(`https://${team}/cdn-cgi/access/certs`, () => HttpResponse.json({ keys: [jwk] })));
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setAudience(AUD)
      .setIssuer(`https://${team}`)
      .setExpirationTime("5m")
      .sign(privateKey);
    for (const pasted of [`https://${team}/`, `  HTTPS://${team}  `, `https://${team}`]) {
      const r = await withEnv(
        req("/api/session", { headers: { "Cf-Access-Jwt-Assertion": token } }),
        { ACCESS_TEAM_DOMAIN: pasted, ACCESS_AUD: AUD },
      );
      expect(r.status).toBe(200);
    }
  });

  it("applies to requests outside /api too, and never reaches the assets binding unchecked", async () => {
    let assetCalls = 0;
    const ASSETS = { fetch: async () => (assetCalls++, new Response("page")) } as unknown as Fetcher;
    const half = await withEnv(req("/index.html"), { ASSETS, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "" });
    expect(half.status).toBe(403);
    expect(await half.json()).toEqual({ error: "access-misconfigured" });

    network.use(http.get("https://empty.cloudflareaccess.com/cdn-cgi/access/certs", () => HttpResponse.json({ keys: [] })));
    const none = await withEnv(req("/index.html"), {
      ASSETS,
      ACCESS_TEAM_DOMAIN: "empty.cloudflareaccess.com",
      ACCESS_AUD: AUD,
    });
    expect(none.status).toBe(403);
    expect(assetCalls).toBe(0);
  });

  it("is checked before the route, so even an unknown path is 403", async () => {
    network.use(http.get("https://empty.cloudflareaccess.com/cdn-cgi/access/certs", () => HttpResponse.json({ keys: [] })));
    const r = await withEnv(req("/api/nope"), { ACCESS_TEAM_DOMAIN: "empty.cloudflareaccess.com", ACCESS_AUD: AUD });
    expect(r.status).toBe(403);
  });
});

it("stores only the hash of the session token", async () => {
  const cookie = await signIn();
  const token = cookie.split("=")[1]!;
  await runInDurableObject(env.HOME.getByName("home"), (_home, state) => {
    const rows = state.storage.sql.exec("SELECT * FROM sessions").toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token); // only the hash is stored
  });
});
