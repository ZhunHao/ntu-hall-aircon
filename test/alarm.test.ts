import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Daikin } from "../src/do/daikin";
import type { Home } from "../src/do/home";
import { nextWake, runConfirm, runDue, type Pending, type RunCtx } from "../src/do/runner";
import type { Store } from "../src/do/store";
import { onSummary } from "../src/shared/events";
import type { Period, Schedule } from "../src/shared/schedule";
import { DAIKIN, fakeJwt, meBody } from "./fixtures/daikin";
import { network } from "./network";

const MIN = 60_000;
const CODE = "A".repeat(24);
const IP = "203.0.113.7";
// Far in the real future, so miniflare never fires an armed alarm on its own during a test.
const MON_2300 = Date.parse("2040-01-02T15:00:00Z"); // Monday 23:00 SGT
const TUE_0700 = Date.parse("2040-01-02T23:00:00Z"); // Tuesday 07:00 SGT
const TUE_1101 = Date.parse("2040-01-03T03:01:00Z"); // Tuesday 11:01 SGT

const night: Period = { day: 0, start: "23:00", end: "07:00", setpoint: 23, mode: "C", fan: "A" };
/** Crosses Tuesday 11:00, so it has a resume at 11:01. */
const late: Period = { day: 0, start: "23:00", end: "12:00", setpoint: 24, mode: "D", fan: "M" };
const sched = (periods: Period[], enabled = true): Schedule => ({ periods, enabled, view: "nights" });

interface Inner {
  store: Store;
  ctx: DurableObjectState;
  daikin(): Promise<Daikin>;
  arm(): Promise<void>;
}
type Stub = ReturnType<typeof env.HOME.getByName>;

let n = 0;
const at = (ms: number) => vi.setSystemTime(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: MON_2300 + 30_000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A fresh Home signed in through the mocked callback. */
async function signedIn(): Promise<Stub> {
  const jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });
  network.use(
    http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } })),
  );
  const stub = env.HOME.getByName(`alarm-${++n}`);
  expect((await stub.signIn(CODE, IP)).ok).toBe(true);
  return stub;
}

const inDo = <R>(stub: Stub, fn: (i: Inner, h: Home) => R | Promise<R>): Promise<R> =>
  runInDurableObject(stub, (h: Home) => fn(h as unknown as Inner, h));

const ctxAt = (i: Inner, now: number, clock = () => now): RunCtx => ({ store: i.store, daikin: () => i.daikin(), now, clock });

/** Writes the schedule straight to storage (no validation, no arming). */
const seed = (stub: Stub, s: Schedule) => inDo(stub, (i) => i.store.put("schedule", s));

/** Save through the API ten minutes before Monday 23:00, then return to 23:00:30. */
async function savedEarlier(stub: Stub, s: Schedule) {
  at(MON_2300 - 10 * MIN);
  expect(await stub.putSchedule(s)).toEqual({ ok: true });
  at(MON_2300 + 30_000);
}

const getAlarm = (stub: Stub) => inDo(stub, (i) => i.ctx.storage.getAlarm());
const kv = <T>(stub: Stub, key: string) => inDo(stub, (i) => i.store.get<T>(key));

/** Counts and captures the urlencoded bodies sent to `/v2/ac/control`. */
function controlSpy(reply: () => Response = () => HttpResponse.json({ meta: { status: 200 } })) {
  const seen = { calls: 0, bodies: [] as string[] };
  network.use(
    http.post(`${DAIKIN}/v2/ac/control`, async ({ request }) => {
      seen.calls++;
      seen.bodies.push(new TextDecoder().decode(await request.arrayBuffer()));
      return reply();
    }),
  );
  return seen;
}

/** `/me` reporting the given aircon state. */
function meSpy(aircon: Record<string, unknown>) {
  const seen = { calls: 0 };
  network.use(
    http.get(`${DAIKIN}/me`, () => {
      seen.calls++;
      return HttpResponse.json(meBody(aircon));
    }),
  );
  return seen;
}

function usageSpy(endtime: string | null) {
  const seen = { calls: 0, urls: [] as string[] };
  network.use(
    http.get(`${DAIKIN}/usage/history`, ({ request }) => {
      seen.calls++;
      seen.urls.push(request.url);
      return HttpResponse.json({
        meta: { offset: 0, limit: 1, rowCount: 9 },
        data: [{ starttime: "2040-01-02T23:00:00.000+08:00", endtime, duration: 1, amount: 0.1 }],
      });
    }),
  );
  return seen;
}

describe("onSummary", () => {
  it("names the setpoint, mode and fan in words", () => {
    expect(onSummary(night)).toBe("On 23 °C Cool, fan auto");
    expect(onSummary(late)).toBe("On 24 °C Dehumidify, fan 3");
    expect(onSummary({ setpoint: 26, mode: "F", fan: "H" })).toBe("On 26 °C Fan, fan 5");
    expect(onSummary({ setpoint: 22, mode: "A", fan: "L" })).toBe("On 22 °C Auto, fan 1");
  });
});

describe("runDue and runConfirm", () => {
  it("a start sends the period's form body and logs done after a matching confirm", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy();

    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 30_000)));
    expect(ctl.bodies).toEqual(["power=1&setpoint=23&mode=C&fanstep=A"]);
    const p = await kv<Pending>(stub, "pending");
    expect(p).toMatchObject({ checkAtMs: MON_2300 + 40_000, expect: { power: 1, setpoint: 23, mode: "C", fanstep: "A" }, retried: false });
    expect(await stub.activity(10)).toEqual([]); // logged on confirm, not on send

    const me = meSpy({ power: 1, setpoint: 23, mode: "C", fanstep: "A" });
    await inDo(stub, (i) => runConfirm(ctxAt(i, MON_2300 + 40_000), p!));
    expect(me.calls).toBe(1);
    expect(ctl.calls).toBe(1);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([
      { kind: "start", summary: "On 23 °C Cool, fan auto", result: "done", at: MON_2300 + 40_000 },
    ]);
  });

  it("an end sends power=0 and logs Off", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_0700 + 5_000)));
    expect(ctl.bodies).toEqual(["power=0"]);
    meSpy({ power: 0 });
    const p = await kv<Pending>(stub, "pending");
    await inDo(stub, (i) => runConfirm(ctxAt(i, TUE_0700 + 15_000), p!));
    expect(await stub.activity(10)).toMatchObject([{ kind: "end", summary: "Off", result: "done" }]);
  });

  it("running the same occurrence twice sends once", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 1_000)));
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 50_000)));
    expect(ctl.calls).toBe(1);
  });

  it("an event 31 minutes late is skipped silently, with no control call", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 31 * MIN)));
    expect(ctl.calls).toBe(0);
    expect(await stub.activity(10)).toEqual([]);
    expect(await kv(stub, "pending")).toBeUndefined();
  });

  it("a disabled schedule switches nothing", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night], false));
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 1_000)));
    expect(ctl.calls).toBe(0);
  });

  it("resume sends the start when the last session ended in Daikin's 11:00 minute", async () => {
    const stub = await signedIn();
    await seed(stub, sched([late]));
    meSpy({ power: 0 });
    const usage = usageSpy("2040-01-03T11:00:05.000+08:00");
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(new URL(usage.urls[0]).search).toBe("?limit=1&offset=0");
    expect(ctl.bodies).toEqual(["power=1&setpoint=24&mode=D&fanstep=M"]);

    meSpy({ power: 1, setpoint: 24, mode: "D", fanstep: "M" });
    const p = await kv<Pending>(stub, "pending");
    await inDo(stub, (i) => runConfirm(ctxAt(i, TUE_1101 + 30_000), p!));
    expect(await stub.activity(10)).toMatchObject([
      { kind: "resume", summary: "Back on after Daikin's 11:00 cut-off", result: "done" },
    ]);
  });

  it("resume does nothing when the resident switched off before 11:00", async () => {
    const stub = await signedIn();
    await seed(stub, sched([late]));
    meSpy({ power: 0 });
    usageSpy("2040-01-03T10:30:00.000+08:00");
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(ctl.calls).toBe(0);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([
      {
        kind: "resume",
        summary: "Back on after Daikin's 11:00 cut-off",
        result: "skipped",
        reason: "switched off before 11:00 (last session ended 10:30)",
      },
    ]);
  });

  it("resume says when usage history has no row, or the last session has no end yet", async () => {
    const stub = await signedIn();
    await seed(stub, sched([late]));
    meSpy({ power: 0 });
    network.use(
      http.get(`${DAIKIN}/usage/history`, () => HttpResponse.json({ meta: { offset: 0, limit: 1, rowCount: 0 }, data: [] })),
    );
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(ctl.calls).toBe(0);
    expect(await stub.activity(10)).toMatchObject([
      { result: "skipped", reason: "switched off before 11:00 (no usage row yet)" },
    ]);

    const stub2 = await signedIn();
    await seed(stub2, sched([late]));
    usageSpy(null);
    await inDo(stub2, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(ctl.calls).toBe(0);
    expect(await stub2.activity(10)).toMatchObject([
      { result: "skipped", reason: "switched off before 11:00 (last session not ended yet)" },
    ]);
  });

  it("resume ignores an 11:00 end on another day", async () => {
    const stub = await signedIn();
    await seed(stub, sched([late]));
    meSpy({ power: 0 });
    usageSpy("2040-01-02T11:00:05.000+08:00");
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(ctl.calls).toBe(0);
    expect(await stub.activity(10)).toMatchObject([
      { result: "skipped", reason: "switched off before 11:00 (last session ended 2 Jan 11:00)" },
    ]);
  });

  it("resume leaves an aircon that is already on alone", async () => {
    const stub = await signedIn();
    await seed(stub, sched([late]));
    meSpy({ power: 1 });
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, TUE_1101 + 20_000)));
    expect(ctl.calls).toBe(0);
    expect(await stub.activity(10)).toMatchObject([{ kind: "resume", result: "skipped", reason: "already on" }]);
  });

  it("a confirm mismatch resends once, then logs failed", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 1_000)));
    const me = meSpy({ power: 0, setpoint: 23, mode: "C", fanstep: "A" });

    const p1 = await kv<Pending>(stub, "pending");
    await inDo(stub, (i) => runConfirm(ctxAt(i, MON_2300 + 11_000), p1!));
    expect(ctl.bodies).toEqual(["power=1&setpoint=23&mode=C&fanstep=A", "power=1&setpoint=23&mode=C&fanstep=A"]);
    const p2 = await kv<Pending>(stub, "pending");
    expect(p2).toMatchObject({ retried: true, checkAtMs: MON_2300 + 21_000, key: p1!.key });
    expect(await stub.activity(10)).toEqual([]);

    await inDo(stub, (i) => runConfirm(ctxAt(i, MON_2300 + 21_000), p2!));
    expect(ctl.calls).toBe(2);
    expect(me.calls).toBe(2);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([
      { kind: "start", result: "failed", reason: "the aircon didn't respond" },
    ]);
  });

  it("a confirm whose command was replaced while /me was in flight neither resends nor logs", async () => {
    const stub = await signedIn();
    const old: Pending = { checkAtMs: MON_2300, key: "old", kind: "start", summary: "On 23 °C Cool, fan auto", expect: { power: 1 }, retried: false };
    const newer: Pending = { ...old, key: "new", expect: { power: 0 }, checkAtMs: MON_2300 + 20_000 };
    await inDo(stub, (i) => i.store.put("pending", old));
    meSpy({ power: 0 }); // a mismatch for `old`, which would resend it
    const ctl = controlSpy();
    await inDo(stub, async (i) => {
      const ctx = ctxAt(i, MON_2300 + 10_000);
      // A newer command lands while /me is in flight.
      const d = await i.daikin();
      const me = d.me.bind(d);
      d.me = async () => {
        i.store.put("pending", newer);
        return me();
      };
      await runConfirm({ ...ctx, daikin: async () => d }, old);
    });
    expect(ctl.calls).toBe(0);
    expect(await kv(stub, "pending")).toEqual(newer);
    expect(await stub.activity(10)).toEqual([]);
  });

  it("times the confirm check from when the control call returned", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    controlSpy();
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 1_000, () => MON_2300 + 8_000)));
    expect((await kv<Pending>(stub, "pending"))?.checkAtMs).toBe(MON_2300 + 18_000);
  });

  it("a Daikin 5xx logs failed, does not throw and is not retried", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const ctl = controlSpy(() => HttpResponse.json({ meta: { status: 500, message: "busy" } }, { status: 500 }));
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 1_000)));
    await inDo(stub, (i) => runDue(ctxAt(i, MON_2300 + 2_000)));
    expect(ctl.calls).toBe(1);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([{ kind: "start", result: "failed" }]);
  });
});

describe("nextWake", () => {
  it("is the next event, or the pending check when that is earlier", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    const now = MON_2300 + 30_000;
    expect(await inDo(stub, (i) => nextWake(i.store, now))).toBe(TUE_0700);
    await inDo(stub, (i) =>
      i.store.put("pending", { checkAtMs: now + 10_000, key: "k", expect: { power: 0 }, retried: false }),
    );
    expect(await inDo(stub, (i) => nextWake(i.store, now))).toBe(now + 10_000);
  });

  it("ignores events when paused but keeps a pending check", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night], false));
    const now = MON_2300 + 30_000;
    expect(await inDo(stub, (i) => nextWake(i.store, now))).toBeNull();
    await inDo(stub, (i) =>
      i.store.put("pending", { checkAtMs: now + 10_000, key: "k", expect: { power: 0 }, retried: false }),
    );
    expect(await inDo(stub, (i) => nextWake(i.store, now))).toBe(now + 10_000);
  });

  it("is null when signed out or expired", async () => {
    const stub = await signedIn();
    await seed(stub, sched([night]));
    await inDo(stub, (i) => i.store.put("expired", true));
    expect(await inDo(stub, (i) => nextWake(i.store, MON_2300))).toBeNull();
    await stub.signOut();
    await seed(stub, sched([night]));
    expect(await inDo(stub, (i) => nextWake(i.store, MON_2300))).toBeNull();
  });
});

describe("alarm", () => {
  it("runs the due start, then a second alarm for the same occurrence sends nothing", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    const ctl = controlSpy();
    const me = meSpy({ power: 1, setpoint: 23, mode: "C", fanstep: "A" });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(1);
    expect(await getAlarm(stub)).toBe(Date.now() + 10_000); // the confirm check

    expect(await runDurableObjectAlarm(stub)).toBe(true); // fires early: the check isn't due yet
    expect(ctl.calls).toBe(1);
    expect(me.calls).toBe(0);

    at(MON_2300 + 41_000);
    await inDo(stub, (i) => i.ctx.storage.setAlarm(Date.now()));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(1);
    expect(me.calls).toBe(1);
    expect(await stub.activity(10)).toMatchObject([{ kind: "start", result: "done" }]);
    expect(await getAlarm(stub)).toBe(TUE_0700);
  });

  it("a 402 during start sets expired and leaves no alarm", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    controlSpy(() => HttpResponse.json({ message: "Unauthorized" }, { status: 402 }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await kv(stub, "expired")).toBe(true);
    expect(await getAlarm(stub)).toBeNull();
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([
      { kind: "start", result: "skipped", reason: "signed out by Daikin" },
    ]);
  });

  it("Review Focus 2: after sign-out an armed alarm sends nothing and leaves no alarm", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    await stub.signOut();
    // As if the alarm survived sign-out (it fires once more).
    await inDo(stub, (i) => i.ctx.storage.setAlarm(Date.now()));
    const ctl = controlSpy();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(0);
    expect(await getAlarm(stub)).toBeNull();
    expect(await stub.activity(10)).toEqual([]);
  });

  it("A1: after OWNER_EMAIL changes an armed alarm sends nothing and leaves no alarm", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    expect(await getAlarm(stub)).not.toBeNull();
    await inDo(stub, (i, h) => {
      (h as unknown as { env: unknown }).env = { ...env, OWNER_EMAIL: "someone-else@e.ntu.edu.sg" };
    });
    const ctl = controlSpy();
    const me = meSpy({ power: 1 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(0);
    expect(me.calls).toBe(0);
    expect(await getAlarm(stub)).toBeNull();
    expect(await stub.activity(10)).toEqual([]);
  });

  it("Review Focus 3: saving the schedule keeps an earlier pending confirm check", async () => {
    const stub = await signedIn();
    const now = Date.now();
    await inDo(stub, (i) =>
      i.store.put("pending", { checkAtMs: now + 10_000, key: "k", expect: { power: 1 }, retried: false }),
    );
    // Next event is the start in one hour: Tuesday 00:00 SGT.
    const inAnHour: Period = { day: 1, start: "00:00", end: "06:00", setpoint: 25, mode: "C", fan: "A" };
    expect(await stub.putSchedule(sched([inAnHour]))).toEqual({ ok: true });
    expect(await getAlarm(stub)).toBe(now + 10_000);
  });

  it("Review Focus 5: a start answered with 200 HTML logs failed and keeps the next event armed", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    controlSpy(() => new HttpResponse("<html>gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.activity(10)).toMatchObject([{ kind: "start", result: "failed" }]);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await getAlarm(stub)).toBe(TUE_0700);
  });

  it("saving a period that started 5 minutes ago never sends its start, even on a later confirm alarm", async () => {
    const stub = await signedIn();
    at(MON_2300 + 5 * MIN);
    await inDo(stub, (i) =>
      i.store.put("pending", { checkAtMs: Date.now(), key: "k", kind: "end", summary: "Off", expect: { power: 0 }, retried: false }),
    );
    expect(await stub.putSchedule(sched([night]))).toEqual({ ok: true });
    expect(await getAlarm(stub)).toBe(Date.now()); // the confirm check
    const ctl = controlSpy();
    meSpy({ power: 0 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(0);
    expect(await stub.activity(10)).toMatchObject([{ kind: "end", result: "done" }]);
    expect(await getAlarm(stub)).toBe(TUE_0700);
  });

  it("an event that comes due during slow Daikin calls still fires", async () => {
    // Back-to-back: 23:00-23:01 then 23:01-23:30, so the next event after 23:00 is the 23:01 start.
    const a: Period = { ...night, end: "23:01" };
    const b: Period = { ...night, start: "23:01", end: "23:30", setpoint: 25 };
    const stub = await signedIn();
    await savedEarlier(stub, sched([a, b]));
    // Daikin takes until 23:01:30 to answer, then fails, so no confirm check is armed.
    controlSpy(() => {
      at(MON_2300 + 90_000);
      return HttpResponse.json({ meta: { status: 500 } }, { status: 500 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await getAlarm(stub)).toBe(MON_2300 + MIN);
  });

  it("a manual change before the confirm check wins: no resend, logged as skipped", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    const ctl = controlSpy();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(1);

    // The resident switches it off from Home a few seconds later.
    at(MON_2300 + 35_000);
    expect(await stub.control({ power: 0 })).toEqual({ ok: true, data: null });
    expect(ctl.bodies).toEqual(["power=1&setpoint=23&mode=C&fanstep=A", "power=0"]);
    expect(await kv(stub, "pending")).toBeUndefined();
    expect(await stub.activity(10)).toMatchObject([
      { kind: "start", summary: "On 23 °C Cool, fan auto", result: "skipped", reason: "you changed it", at: MON_2300 + 35_000 },
    ]);

    // The confirm check's alarm still fires: it sees the aircon off and leaves it alone.
    const me = meSpy({ power: 0, setpoint: 23, mode: "C", fanstep: "A" });
    at(MON_2300 + 41_000);
    await inDo(stub, (i) => i.ctx.storage.setAlarm(Date.now()));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(2);
    expect(me.calls).toBe(0);
    expect(await stub.activity(10)).toHaveLength(1);
    expect(await getAlarm(stub)).toBe(TUE_0700);
  });

  it("a failed manual change keeps the pending check", async () => {
    const stub = await signedIn();
    await savedEarlier(stub, sched([night]));
    controlSpy();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    controlSpy(() => HttpResponse.json({ meta: { status: 500 } }, { status: 500 }));
    expect(await stub.control({ power: 0 })).toEqual({ ok: false, status: 502, error: "daikin" });
    expect(await kv<Pending>(stub, "pending")).toMatchObject({ kind: "start" });
    expect(await stub.activity(10)).toEqual([]);
  });

  it("a pending check still runs while the schedule is paused", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night], false));
    expect(await getAlarm(stub)).toBeNull();
    await inDo(stub, (i) =>
      i.store.put("pending", { checkAtMs: Date.now(), key: "apply#1", kind: "apply", summary: "On 23 °C Cool, fan auto", expect: { power: 1 }, retried: false }),
    );
    await inDo(stub, (i) => i.arm());
    expect(await getAlarm(stub)).toBe(Date.now());
    meSpy({ power: 1 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.activity(10)).toMatchObject([{ kind: "apply", result: "done" }]);
    expect(await getAlarm(stub)).toBeNull();
  });
});

describe("putSchedule", () => {
  it("defaults to an empty, enabled nights schedule", async () => {
    const stub = await signedIn();
    expect(await stub.getSchedule()).toEqual({ periods: [], enabled: true, view: "nights" });
  });

  it("stores a valid schedule and arms the next event without switching the aircon", async () => {
    const stub = await signedIn();
    const ctl = controlSpy();
    expect(await stub.putSchedule(sched([night]))).toEqual({ ok: true });
    expect(await stub.getSchedule()).toEqual(sched([night]));
    expect(await getAlarm(stub)).toBe(TUE_0700); // the 23:00 start already passed 30 s ago
    expect(ctl.calls).toBe(0);
  });

  it("a disabled schedule leaves no alarm", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    expect(await stub.putSchedule(sched([night], false))).toEqual({ ok: true });
    expect(await getAlarm(stub)).toBeNull();
  });

  it("returns overlap problems and stores nothing", async () => {
    const stub = await signedIn();
    const clash: Period = { ...night, start: "01:00", end: "03:00", day: 1 };
    const r = await stub.putSchedule(sched([night, clash]));
    expect(r).toEqual({ ok: false, problems: [{ code: "overlap", index: 1, other: 0 }] });
    expect(await kv(stub, "schedule")).toBeUndefined();
    expect(await getAlarm(stub)).toBeNull();
  });

  it("rejects a malformed body without storing", async () => {
    const stub = await signedIn();
    const bads: unknown[] = [
      null,
      [],
      "x",
      {},
      { periods: [], enabled: "yes", view: "nights" },
      { periods: [], enabled: true, view: "weeks" },
      { periods: {}, enabled: true, view: "nights" },
      { periods: [null], enabled: true, view: "nights" },
      { periods: [[]], enabled: true, view: "nights" },
      { periods: [{ ...night, start: ["23:00"] }], enabled: true, view: "nights" },
      { periods: [{ ...night, setpoint: "23" }], enabled: true, view: "nights" },
      { periods: Array.from({ length: 101 }, () => night), enabled: true, view: "nights" },
    ];
    for (const b of bads) {
      expect(await stub.putSchedule(b as Schedule)).toEqual({ ok: false, problems: [] });
    }
    expect(await kv(stub, "schedule")).toBeUndefined();
  });

  it("stores only the period fields", async () => {
    const stub = await signedIn();
    await stub.putSchedule({ periods: [{ ...night, extra: 1 } as Period], enabled: true, view: "days", junk: 2 } as Schedule);
    expect(await stub.getSchedule()).toEqual({ periods: [night], enabled: true, view: "days" });
  });
});

describe("signIn arming", () => {
  it("still succeeds when arm throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } })),
    );
    const stub = env.HOME.getByName(`alarm-${++n}`);
    const r = await inDo(stub, (i, h) => {
      i.arm = async () => {
        throw new Error("storage down");
      };
      return h.signIn(CODE, IP);
    });
    expect(r.ok).toBe(true);
  });

  it("drops a confirm check left by an expired or ended login, so an old command is never resent", async () => {
    const stub = await signedIn();
    const old = { checkAtMs: Date.now() - MIN, key: "k", kind: "start", summary: "Off", expect: { power: 1 }, retried: false };
    await inDo(stub, (i) => {
      i.store.put("pending", old);
      i.store.put("expired", true);
    });
    const jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } })),
    );
    expect((await stub.signIn(CODE, IP)).ok).toBe(true);
    expect(await kv(stub, "pending")).toBeUndefined();

    await inDo(stub, (i) => i.store.put("pending", old));
    await stub.signOut();
    expect(await kv(stub, "pending")).toBeUndefined();
  });

  it("arms the stored schedule on sign-in", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    await stub.signOut();
    expect(await getAlarm(stub)).toBeNull();
    const jwt = fakeJwt({ email: "ABC123@e.ntu.edu.sg" });
    network.use(
      http.post(`${DAIKIN}/auth/ad/callback`, () => HttpResponse.json({ meta: { status: 200 }, data: { token: jwt } })),
    );
    expect((await stub.signIn(CODE, IP)).ok).toBe(true);
    expect(await getAlarm(stub)).toBe(TUE_0700);
  });
});

describe("applyNow", () => {
  it("is not sent again by the confirm alarm for a period saved just now", async () => {
    const stub = await signedIn();
    at(MON_2300 + 5 * MIN);
    await stub.putSchedule(sched([night]));
    const ctl = controlSpy();
    expect(await stub.applyNow()).toEqual({ ok: true, data: { applied: true } });
    at(Date.now() + 10_000);
    meSpy({ power: 1, setpoint: 23, mode: "C", fanstep: "A" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(ctl.calls).toBe(1);
    expect(await stub.activity(10)).toMatchObject([{ kind: "apply", result: "done" }]);
  });

  it("stands in for the occurrence due now, so a late alarm doesn't send it again", async () => {
    const stub = await signedIn();
    at(MON_2300 - 10 * MIN);
    await stub.putSchedule(sched([night]));
    at(MON_2300 + 5_000); // the 23:00 alarm hasn't fired yet
    const ctl = controlSpy();
    expect(await stub.applyNow()).toEqual({ ok: true, data: { applied: true } });
    expect(await runDurableObjectAlarm(stub)).toBe(true); // late 23:00 alarm; the check isn't due yet
    expect(ctl.calls).toBe(1);
  });

  it("sends the start for the period covering now and confirms it as apply", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    at(MON_2300 + 2 * 3600e3); // 01:00 Tuesday, inside the night
    const ctl = controlSpy();
    expect(await stub.applyNow()).toEqual({ ok: true, data: { applied: true } });
    expect(ctl.bodies).toEqual(["power=1&setpoint=23&mode=C&fanstep=A"]);
    expect(await getAlarm(stub)).toBe(Date.now() + 10_000);

    at(Date.now() + 10_000);
    meSpy({ power: 1, setpoint: 23, mode: "C", fanstep: "A" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.activity(10)).toMatchObject([{ kind: "apply", summary: "On 23 °C Cool, fan auto", result: "done" }]);
  });

  it("sends nothing outside every period, or when paused", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    at(TUE_0700 + 60 * MIN);
    expect(await stub.applyNow()).toEqual({ ok: true, data: { applied: false } });
    await stub.putSchedule(sched([night], false));
    at(MON_2300 + 60 * MIN);
    expect(await stub.applyNow()).toEqual({ ok: true, data: { applied: false } });
  });

  it("maps errors like the proxy", async () => {
    const stub = await signedIn();
    await stub.putSchedule(sched([night]));
    controlSpy(() => HttpResponse.json({ meta: { status: 500 } }, { status: 500 }));
    expect(await stub.applyNow()).toEqual({ ok: false, status: 502, error: "daikin" });
    await stub.signOut();
    expect(await stub.applyNow()).toEqual({ ok: false, status: 401, error: "expired" });
  });
});

describe("activity", () => {
  it("clamps the limit to 1..200", async () => {
    const stub = await signedIn();
    await inDo(stub, (i) => {
      for (let k = 0; k < 205; k++) i.store.log({ at: k, kind: "start", summary: "Off", result: "done" });
    });
    expect(await stub.activity(0)).toHaveLength(1);
    expect(await stub.activity(500)).toHaveLength(200);
    expect(await stub.activity(3)).toHaveLength(3);
  });
});
