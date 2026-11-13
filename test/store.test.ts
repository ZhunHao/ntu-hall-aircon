import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, randomToken, sha256Hex, validSecret } from "../src/do/crypto";
import { Store } from "../src/do/store";

const SECRET = "11".repeat(32);
const DAY = 86_400_000;
const MIN = 60_000;

function withStore<R>(name: string, fn: (s: Store, sql: SqlStorage) => R | Promise<R>): Promise<R> {
  return runInDurableObject(env.HOME.getByName(name), (_, state) =>
    fn(new Store(state.storage.sql), state.storage.sql),
  );
}

describe("crypto", () => {
  it("round-trips and uses a fresh IV each call", async () => {
    const a = await encrypt(SECRET, "my.jwt.value");
    const b = await encrypt(SECRET, "my.jwt.value");
    expect(a).not.toBe(b);
    expect(a).not.toContain("my.jwt.value");
    expect(await decrypt(SECRET, a)).toBe("my.jwt.value");
    expect(await decrypt(SECRET, b)).toBe("my.jwt.value");
  });

  it("rejects a different secret", async () => {
    const blob = await encrypt(SECRET, "x");
    await expect(decrypt("22".repeat(32), blob)).rejects.toThrow();
  });

  it("hashes and mints tokens", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it("validSecret needs exactly 64 hex chars", () => {
    expect(validSecret("ab".repeat(32))).toBe(true);
    expect(validSecret("AB".repeat(32))).toBe(true);
    expect(validSecret("a".repeat(63))).toBe(false);
    expect(validSecret("a".repeat(65))).toBe(false);
    expect(validSecret("g".repeat(64))).toBe(false);
    expect(validSecret(undefined)).toBe(false);
    expect(validSecret("")).toBe(false);
  });
});

describe("Store", () => {
  it("kv stores JSON values; missing key is undefined; del removes", () =>
    withStore("kv", (s) => {
      expect(s.get("nope")).toBeUndefined();
      s.put("a", { x: [1, 2], y: "z" });
      s.put("b", false);
      expect(s.get("a")).toEqual({ x: [1, 2], y: "z" });
      expect(s.get("b")).toBe(false);
      s.put("a", 5);
      expect(s.get("a")).toBe(5);
      s.del("a");
      expect(s.get("a")).toBeUndefined();
    }));

  it("an expired session is not valid", () =>
    withStore("sessions", (s) => {
      s.addSession("h1", 1000);
      expect(s.hasSession("h1", 999)).toBe(true);
      expect(s.hasSession("h1", 1000)).toBe(false);
      expect(s.hasSession("h1", 2000)).toBe(false);
      expect(s.hasSession("other", 0)).toBe(false);
    }));

  it("clearSessions empties the table", () =>
    withStore("clear", (s, sql) => {
      s.addSession("h1", 5000);
      s.addSession("h2", 5000);
      s.clearSessions();
      expect(sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n).toBe(0);
      expect(s.hasSession("h1", 0)).toBe(false);
    }));

  it("activity returns newest first and honours the limit", () =>
    withStore("activity", (s) => {
      s.log({ at: 1, kind: "start", summary: "one", result: "done" });
      s.log({ at: 3, kind: "end", summary: "three", result: "failed", reason: "boom" });
      s.log({ at: 2, kind: "resume", summary: "two", result: "skipped" });
      const all = s.activity(10);
      expect(all.map((a) => a.summary)).toEqual(["three", "two", "one"]);
      expect(all[0]).toMatchObject({ kind: "end", result: "failed", reason: "boom" });
      expect(all[1]?.reason).toBeUndefined();
      expect(typeof all[0]?.id).toBe("number");
      expect(s.activity(2)).toHaveLength(2);
    }));

  it("prune drops activity older than 90 days and keeps newer", () =>
    withStore("prune", (s) => {
      const now = 200 * DAY;
      s.log({ at: now - 91 * DAY, kind: "start", summary: "old", result: "done" });
      s.log({ at: now - 89 * DAY, kind: "end", summary: "recent", result: "done" });
      s.prune(now);
      expect(s.activity(10).map((a) => a.summary)).toEqual(["recent"]);
    }));

  const LIM = { perIp: 3, total: 100 };

  it("attempt counts per ip and in total inside the window", () =>
    withStore("attempt", (s) => {
      const win = 10 * MIN;
      expect(s.attempt("A", 0, win, LIM)).toEqual({ allowed: true, ip: 1, total: 1 });
      expect(s.attempt("A", 1 * MIN, win, LIM)).toEqual({ allowed: true, ip: 2, total: 2 });
      expect(s.attempt("A", 2 * MIN, win, LIM)).toEqual({ allowed: true, ip: 3, total: 3 });
      // another ip adds to the total, not to the first ip's count
      expect(s.attempt("B", 3 * MIN, win, LIM)).toEqual({ allowed: true, ip: 1, total: 4 });
      // after the window passes only the newest counts
      expect(s.attempt("A", 20 * MIN, win, LIM)).toEqual({ allowed: true, ip: 1, total: 1 });
    }));

  it("attempt refuses past the per-ip limit and records nothing for the refused call", () =>
    withStore("attempt-refuse-ip", (s, sql) => {
      const win = 10 * MIN;
      for (let i = 0; i < 3; i++) expect(s.attempt("A", i, win, LIM).allowed).toBe(true);
      for (let i = 0; i < 20; i++) {
        expect(s.attempt("A", 10 + i, win, LIM)).toEqual({ allowed: false, ip: 3, total: 3 });
      }
      expect(sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n).toBe(3);
      expect(s.attempt("B", 40, win, LIM)).toEqual({ allowed: true, ip: 1, total: 4 });
    }));

  it("attempt refuses past the total limit and records nothing for the refused call", () =>
    withStore("attempt-refuse-total", (s, sql) => {
      const win = 10 * MIN;
      const lim = { perIp: 5, total: 4 };
      for (let i = 0; i < 4; i++) expect(s.attempt(`ip${i}`, i, win, lim).allowed).toBe(true);
      expect(s.attempt("fresh", 10, win, lim)).toEqual({ allowed: false, ip: 0, total: 4 });
      expect(sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n).toBe(4);
    }));

  it("attempt deletes rows older than the window", () =>
    withStore("attempt-prune", (s, sql) => {
      const win = 10 * MIN;
      s.attempt("A", 0, win, LIM);
      s.attempt("B", 1 * MIN, win, LIM);
      s.attempt("A", 10 * MIN + 1, win, LIM); // drops the row at 0, keeps the 1 min row and itself
      expect(sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n).toBe(2);
      s.attempt("A", 30 * MIN, win, LIM);
      expect(sql.exec("SELECT COUNT(*) AS n FROM attempts").one().n).toBe(1);
    }));

  it("the attempts table has indexes on at and (ip, at)", () =>
    withStore("attempt-index", (_, sql) => {
      const cols = sql
        .exec<{ name: string }>("SELECT name FROM pragma_index_list('attempts')")
        .toArray()
        .map((r) => sql.exec<{ name: string }>(`SELECT name FROM pragma_index_info('${r.name}') ORDER BY seqno`).toArray().map((c) => c.name).join(","));
      expect(cols).toEqual(expect.arrayContaining(["at", "ip,at"]));
    }));

});
