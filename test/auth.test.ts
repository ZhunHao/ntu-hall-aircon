import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/do/crypto";
import { DaikinExpired, jwtClaims } from "../src/do/daikin";
import { configured, Home, isOwner } from "../src/do/home";
import { DAIKIN, fakeJwt } from "./fixtures/daikin";
import { network } from "./network";

const OWNER = "abc123@e.ntu.edu.sg";
const MIN = 60_000;
const CODE = "A".repeat(24); // extractCode accepts a bare token of 16+ base64 chars
const IP = "203.0.113.7";

/** Mock /auth/ad/callback so it hands back `jwt`. Returns what the handler saw. */
function mockCallback(jwt: string): { calls: number; body: string } {
  const seen = { calls: 0, body: "" };
  network.use(
    http.post(`${DAIKIN}/auth/ad/callback`, async ({ request }) => {
      seen.calls++;
      seen.body = new TextDecoder().decode(await request.arrayBuffer());
      return HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } });
    }),
  );
  return seen;
}

const goodJwt = (over: { email?: string; exp?: number } = {}) =>
  fakeJwt({ email: "ABC123@e.ntu.edu.sg", ...over });

const stub = (name: string) => env.HOME.getByName(name);

/** Read the DO's SQLite directly. */
const inDo = <R>(name: string, fn: (home: Home, sql: SqlStorage) => R | Promise<R>): Promise<R> =>
  runInDurableObject(stub(name), (home: Home, state) => fn(home, state.storage.sql));

const kv = (name: string, key: string) =>
  inDo(name, (_, sql) => {
    const r = sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    return r[0] ? (JSON.parse(r[0].value) as unknown) : undefined;
  });

describe("isOwner", () => {
  it("ignores case and surrounding spaces", () => {
    expect(isOwner(" Abc123@E.ntu.edu.sg ", "ABC123@e.ntu.edu.sg")).toBe(true);
  });
  it("rejects a different address", () => {
    expect(isOwner("abc123@e.ntu.edu.sg", "abc1234@e.ntu.edu.sg")).toBe(false);
  });
  it("is false when either side is empty or blank", () => {
    expect(isOwner("", "")).toBe(false);
    expect(isOwner("  ", "  ")).toBe(false);
    expect(isOwner("", "abc123@e.ntu.edu.sg")).toBe(false);
    expect(isOwner("abc123@e.ntu.edu.sg", "")).toBe(false);
    expect(isOwner("abc123@e.ntu.edu.sg", "   ")).toBe(false);
  });
});

describe("configured", () => {
  const ok = { OWNER_EMAIL: OWNER, SESSION_SECRET: "11".repeat(32) };
  it("accepts a real owner and a 64-hex secret", () => {
    expect(configured(ok)).toBe(true);
  });
  it("rejects a missing or blank OWNER_EMAIL", () => {
    expect(configured({ ...ok, OWNER_EMAIL: undefined as unknown as string })).toBe(false);
    expect(configured({ ...ok, OWNER_EMAIL: "" })).toBe(false);
    expect(configured({ ...ok, OWNER_EMAIL: "   " })).toBe(false);
  });
  it("rejects the placeholder owner, however it is spaced or cased", () => {
    expect(configured({ ...ok, OWNER_EMAIL: "your-id@e.ntu.edu.sg" })).toBe(false);
    expect(configured({ ...ok, OWNER_EMAIL: "  Your-ID@E.ntu.edu.sg " })).toBe(false);
  });
  it("rejects a SESSION_SECRET that is not exactly 64 hex chars", () => {
    expect(configured({ ...ok, SESSION_SECRET: "" })).toBe(false);
    expect(configured({ ...ok, SESSION_SECRET: "11".repeat(31) })).toBe(false);
    expect(configured({ ...ok, SESSION_SECRET: "zz".repeat(32) })).toBe(false);
    expect(configured({ ...ok, SESSION_SECRET: undefined as unknown as string })).toBe(false);
  });
});

describe("signIn", () => {
  it("returns a token whose hash is a valid session carrying the email", async () => {
    const jwt = goodJwt();
    const seen = mockCallback(jwt);
    const home = stub("good");
    const r = await home.signIn(CODE, IP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen.calls).toBe(1);
    expect(seen.body).toContain(`hash=${CODE}`);
    expect(seen.body).toContain("fcm_token=placeholder");
    expect(r.expiresMs).toBe(jwtClaims(jwt).exp * 1000);

    const info = await home.session(await sha256Hex(r.token));
    expect(info).toEqual({ valid: true, email: "ABC123@e.ntu.edu.sg", expiresMs: r.expiresMs, expired: false });

    // only the hash is stored; the JWT is encrypted; the token is nowhere
    const dump = await inDo("good", (_, sql) => JSON.stringify([...sql.exec("SELECT * FROM kv"), ...sql.exec("SELECT * FROM sessions")]));
    expect(dump).not.toContain(r.token);
    expect(dump).not.toContain(jwt);
    expect(await kv("good", "jwtExp")).toBe(r.expiresMs);
    expect(await kv("good", "fake")).toBe(false);
  });

  it("accepts a pasted address, not only a bare code", async () => {
    mockCallback(goodJwt());
    const r = await stub("paste").signIn(`https://x.example/adfs/saml/redirect/${CODE}`, IP);
    expect(r.ok).toBe(true);
  });

  it("owner mismatch returns not-owner and stores nothing", async () => {
    mockCallback(goodJwt({ email: "OTHER@e.ntu.edu.sg" }));
    const home = stub("other");
    expect(await home.signIn(CODE, IP)).toEqual({ ok: false, error: "not-owner" });
    expect(await kv("other", "jwt")).toBeUndefined();
    expect(await kv("other", "jwtExp")).toBeUndefined();
    expect(await kv("other", "email")).toBeUndefined();
    expect(await inDo("other", (_, sql) => sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n)).toBe(0);
  });

  it("a JWT that has already expired returns rejected and stores nothing", async () => {
    mockCallback(goodJwt({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(await stub("lapsed").signIn(CODE, IP)).toEqual({ ok: false, error: "rejected" });
    expect(await kv("lapsed", "jwt")).toBeUndefined();
    expect(await kv("lapsed", "jwtExp")).toBeUndefined();
    expect(await inDo("lapsed", (_, sql) => sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n)).toBe(0);
  });

  it("unparsable paste returns no-code without calling Daikin", async () => {
    const seen = mockCallback(goodJwt());
    expect(await stub("nocode").signIn("hello", IP)).toEqual({ ok: false, error: "no-code" });
    expect(await stub("nocode").signIn("", IP)).toEqual({ ok: false, error: "no-code" });
    expect(seen.calls).toBe(0);
  });

  it("a Daikin 4xx returns rejected", async () => {
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ message: "bad hash" }, { status: 422 })),
    );
    const home = stub("rejected");
    expect(await home.signIn(CODE, IP)).toEqual({ ok: false, error: "rejected" });
    expect(await kv("rejected", "jwt")).toBeUndefined();
  });

  it("a Daikin 402 is rejected too, never surfaced as expired", async () => {
    network.use(http.post(`${DAIKIN}/auth/ad/callback`, () => new HttpResponse(null, { status: 402 })));
    expect(await stub("rejected402").signIn(CODE, IP)).toEqual({ ok: false, error: "rejected" });
  });

  it("a Daikin 200 with an HTML body is rejected", async () => {
    network.use(http.post(`${DAIKIN}/auth/ad/callback`, () => new HttpResponse("<html>", { status: 200 })));
    expect(await stub("rejectedhtml").signIn(CODE, IP)).toEqual({ ok: false, error: "rejected" });
  });

  it("a token that is not a JWT is rejected", async () => {
    mockCallback("not-a-jwt");
    const home = stub("notjwt");
    expect(await home.signIn(CODE, IP)).toEqual({ ok: false, error: "rejected" });
    expect(await kv("notjwt", "jwt")).toBeUndefined();
  });

  it("a fresh sign-in clears the expired flag", async () => {
    mockCallback(goodJwt());
    await inDo("clears-expired", (home) => (home as unknown as { store: { put(k: string, v: unknown): void } }).store.put("expired", true));
    expect(await kv("clears-expired", "expired")).toBe(true);
    await stub("clears-expired").signIn(CODE, IP);
    expect(await kv("clears-expired", "expired")).toBeFalsy();
  });
});

describe("sign-in rate limit", () => {
  it("the 6th attempt from one ip within 10 minutes is rate-limited", async () => {
    const home = stub("rl-ip");
    for (let i = 0; i < 5; i++) expect(await home.signIn("nope", "A")).toEqual({ ok: false, error: "no-code" });
    expect(await home.signIn("nope", "A")).toEqual({ ok: false, error: "rate-limited" });
  });

  it("is counted before the exchange, so rate-limited makes no Daikin call", async () => {
    const seen = mockCallback(goodJwt());
    const home = stub("rl-before");
    for (let i = 0; i < 5; i++) await home.signIn("nope", "A");
    expect(await home.signIn(CODE, "A")).toEqual({ ok: false, error: "rate-limited" });
    expect(seen.calls).toBe(0);
  });

  it("5 failed tries from ip A do not block ip B", async () => {
    mockCallback(goodJwt());
    const home = stub("rl-ab");
    for (let i = 0; i < 6; i++) await home.signIn("nope", "A");
    const r = await home.signIn(CODE, "B");
    expect(r.ok).toBe(true);
  });

  it("the 51st attempt overall is rate-limited", async () => {
    const home = stub("rl-total");
    for (let i = 0; i < 50; i++) {
      // 10 ips x 5 attempts each: no single ip exceeds its limit
      expect(await home.signIn("nope", `ip${i % 10}`)).toEqual({ ok: false, error: "no-code" });
    }
    expect(await home.signIn("nope", "fresh-ip")).toEqual({ ok: false, error: "rate-limited" });
  });

  it("one ip hammering sign-in cannot fill the global cap or the table", async () => {
    mockCallback(goodJwt());
    const home = stub("rl-flood");
    for (let i = 0; i < 50; i++) await home.signIn("nope", "A");
    expect((await home.signIn(CODE, "B")).ok).toBe(true);
    const rows = await inDo("rl-flood", (_, sql) =>
      sql.exec("SELECT COUNT(*) AS n FROM attempts WHERE ip = 'A'").one().n,
    );
    expect(rows).toBeLessThanOrEqual(5 + 1);
  });

  it("the attempts table does not grow past the window", async () => {
    const home = stub("rl-prune");
    await inDo("rl-prune", (_, sql) => {
      for (let i = 0; i < 20; i++)
        sql.exec("INSERT INTO attempts (at, ip) VALUES (?, ?)", Date.now() - 11 * MIN - i, "old");
    });
    await home.signIn("nope", "A");
    expect(await inDo("rl-prune", (_, sql) => sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n)).toBe(1);
  });
});

describe("sign-in config check (S4)", () => {
  /** Run signIn on a Home whose bindings are replaced. */
  const withEnv = (name: string, over: Record<string, unknown>) =>
    inDo(name, async (home, sql) => {
      (home as unknown as { env: unknown }).env = { ...env, ...over };
      const r = await home.signIn(CODE, IP);
      return { r, attempts: sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n };
    });

  it.each([
    ["OWNER_EMAIL missing", { OWNER_EMAIL: undefined }],
    ["OWNER_EMAIL blank", { OWNER_EMAIL: "  " }],
    ["OWNER_EMAIL is the placeholder", { OWNER_EMAIL: " Your-Id@e.ntu.edu.sg" }],
    ["SESSION_SECRET is not 64 hex", { SESSION_SECRET: "abc" }],
  ])("%s returns not-configured, records no attempt, makes no call", async (label, over) => {
    const seen = mockCallback(goodJwt());
    const { r, attempts } = await withEnv(`cfg-${label}`, over);
    expect(r).toEqual({ ok: false, error: "not-configured" });
    expect(attempts).toBe(0);
    expect(seen.calls).toBe(0);
  });
});

describe("owner change (A1)", () => {
  const OTHER = "def456@e.ntu.edu.sg";
  const setOwner = (name: string, owner: string) =>
    inDo(name, (home) => {
      (home as unknown as { env: unknown }).env = { ...env, OWNER_EMAIL: owner };
    });
  const hashOf = async (r: Awaited<ReturnType<Home["signIn"]>>) => sha256Hex((r as { token: string }).token);

  it("a new owner's sign-in ends the former owner's sessions and clears pending and done", async () => {
    const name = "owner-change";
    mockCallback(goodJwt());
    const home = stub(name);
    const a = await home.signIn(CODE, IP);
    expect(a.ok).toBe(true);
    const hashA = await hashOf(a);
    await inDo(name, (h) => {
      const s = (h as unknown as { store: { put(k: string, v: unknown): void } }).store;
      s.put("pending", { x: 1 });
      s.put("done", { y: 1 });
    });
    expect((await home.session(hashA)).valid).toBe(true);

    await setOwner(name, OTHER);
    mockCallback(goodJwt({ email: OTHER.toUpperCase() }));
    const b = await home.signIn(CODE, "198.51.100.9");
    expect(b.ok).toBe(true);
    expect((await home.session(hashA)).valid).toBe(false);
    expect((await home.session(await hashOf(b))).valid).toBe(true);
    expect(await kv(name, "pending")).toBeUndefined();
    expect(await kv(name, "done")).toBeUndefined();
    expect(await kv(name, "email")).toBe(OTHER.toUpperCase());
  });

  it("the same owner signing in again keeps other sessions and the schedule state", async () => {
    const name = "owner-same";
    mockCallback(goodJwt());
    const home = stub(name);
    const a = await home.signIn(CODE, IP);
    await inDo(name, (h) => (h as unknown as { store: { put(k: string, v: unknown): void } }).store.put("done", { y: 1 }));
    mockCallback(goodJwt({ email: " abc123@E.ntu.edu.sg " }));
    expect((await home.signIn(CODE, IP)).ok).toBe(true);
    expect((await home.session(await hashOf(a))).valid).toBe(true);
    expect(await kv(name, "done")).toEqual({ y: 1 });
  });

  it("switching OWNER_EMAIL alone makes the old session invalid", async () => {
    const name = "owner-switch-only";
    mockCallback(goodJwt());
    const home = stub(name);
    const a = await home.signIn(CODE, IP);
    const hashA = await hashOf(a);
    expect((await home.session(hashA)).valid).toBe(true);
    await setOwner(name, OTHER);
    expect(await home.session(hashA)).toEqual({ valid: false });
  });
});

describe("fake sign-in (R7)", () => {
  it("never touches the network and stores kv fake = true", async () => {
    // no MSW handler is registered: an outbound call would fail the test
    const home = stub("fake");
    const r = await home.signIn(CODE, IP, true);
    expect(r.ok).toBe(true);
    expect(await kv("fake", "fake")).toBe(true);
    const info = await home.session(await sha256Hex((r as { token: string }).token));
    expect(info.valid).toBe(true);
    expect(info.email).toBe("ABC123@e.ntu.edu.sg");
  });

  it("daikin() uses the fake offline when kv fake is true, with one fetcher per instance", async () => {
    await stub("fake-use").signIn(CODE, IP, true);
    await inDo("fake-use", async (home) => {
      const h = home as unknown as {
        fake(): typeof fetch;
        daikin(): Promise<{ me(): Promise<{ aircon: unknown }> }>;
      };
      expect((await (await h.daikin()).me()).aircon).not.toBeNull(); // no MSW handler: offline
      expect(h.fake()).toBe(h.fake());
    });
  });

  it("a later real sign-in stores fake = false", async () => {
    await stub("fake-then-real").signIn(CODE, IP, true);
    mockCallback(goodJwt());
    await stub("fake-then-real").signIn(CODE, "other-ip");
    expect(await kv("fake-then-real", "fake")).toBe(false);
  });
});

describe("session", () => {
  it("an unknown hash is invalid and carries no email key", async () => {
    const info = await stub("unknown").session("0".repeat(64));
    expect(info).toEqual({ valid: false });
    expect("email" in info).toBe(false);
    expect("expiresMs" in info).toBe(false);
  });

  it("a session past its expiry is invalid", async () => {
    mockCallback(goodJwt());
    const home = stub("expired-session");
    const r = await home.signIn(CODE, IP);
    if (!r.ok) throw new Error("sign-in failed");
    const hash = await sha256Hex(r.token);
    expect((await home.session(hash)).valid).toBe(true);
    await inDo("expired-session", (_, sql) => sql.exec("UPDATE sessions SET expires = ?", Date.now() - 1));
    const info = await home.session(hash);
    expect(info).toEqual({ valid: false });
  });

  it("expired mirrors kv expired for a valid session", async () => {
    mockCallback(goodJwt());
    const home = stub("expired-flag");
    const r = await home.signIn(CODE, IP);
    if (!r.ok) throw new Error("sign-in failed");
    const hash = await sha256Hex(r.token);
    await inDo("expired-flag", (h) => (h as unknown as { store: { put(k: string, v: unknown): void } }).store.put("expired", true));
    expect(await home.session(hash)).toMatchObject({ valid: true, expired: true });
  });
});

describe("daikin()", () => {
  const getDaikin = (name: string) =>
    inDo(name, (home) => (home as unknown as { daikin(): Promise<unknown> }).daikin());

  it("throws DaikinExpired when nobody has signed in", async () => {
    await expect(getDaikin("dk-none")).rejects.toBeInstanceOf(DaikinExpired);
  });

  it("returns a client after a real sign-in", async () => {
    mockCallback(goodJwt());
    await stub("dk-ok").signIn(CODE, IP);
    expect(await getDaikin("dk-ok")).toBeTruthy();
  });

  it("throws DaikinExpired when the expired flag is set", async () => {
    mockCallback(goodJwt());
    await stub("dk-flag").signIn(CODE, IP);
    await inDo("dk-flag", (h) => (h as unknown as { store: { put(k: string, v: unknown): void } }).store.put("expired", true));
    await expect(getDaikin("dk-flag")).rejects.toBeInstanceOf(DaikinExpired);
  });

  it("throws DaikinExpired when jwtExp is in the past", async () => {
    mockCallback(goodJwt());
    await stub("dk-past").signIn(CODE, IP);
    await inDo("dk-past", (h) => (h as unknown as { store: { put(k: string, v: unknown): void } }).store.put("jwtExp", Date.now() - 1));
    await expect(getDaikin("dk-past")).rejects.toBeInstanceOf(DaikinExpired);
  });
});

describe("signOut", () => {
  it("ends every session, deletes the login and leaves no alarm, keeping the schedule", async () => {
    mockCallback(goodJwt());
    const home = stub("signout");
    const a = await home.signIn(CODE, "ip-a");
    mockCallback(goodJwt());
    const b = await home.signIn(CODE, "ip-b");
    if (!a.ok || !b.ok) throw new Error("sign-in failed");
    await inDo("signout", async (h) => {
      (h as unknown as { store: { put(k: string, v: unknown): void } }).store.put("schedule", [{ id: "p1" }]);
      await (h as unknown as { ctx: DurableObjectState }).ctx.storage.setAlarm(Date.now() + 60_000);
    });

    await home.signOut();

    expect((await home.session(await sha256Hex(a.token))).valid).toBe(false);
    expect((await home.session(await sha256Hex(b.token))).valid).toBe(false);
    for (const key of ["jwt", "jwtExp", "email", "fake"]) expect(await kv("signout", key)).toBeUndefined();
    expect(await kv("signout", "schedule")).toEqual([{ id: "p1" }]);
    expect(await inDo("signout", (h) => (h as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm())).toBeNull();
    await expect(
      inDo("signout", (h) => (h as unknown as { daikin(): Promise<unknown> }).daikin()),
    ).rejects.toBeInstanceOf(DaikinExpired);
  });
});
