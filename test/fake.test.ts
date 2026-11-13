import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daikin, DaikinExpired, jwtClaims } from "../src/do/daikin";
import { fakeFetch } from "../src/do/fake";

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-30T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

async function signedIn(owner?: string): Promise<Daikin> {
  const fetcher = fakeFetch(owner);
  const jwt = await new Daikin(null, fetcher).exchange("any-hash");
  return new Daikin(jwt, fetcher);
}

describe("fakeFetch", () => {
  it("exchange returns a 90-day JWT whose email lower-cases to the owner", async () => {
    const jwt = await new Daikin(null, fakeFetch("abc123@e.ntu.edu.sg")).exchange("hash");
    const { email, exp } = jwtClaims(jwt);
    expect(email).toBe("ABC123@e.ntu.edu.sg");
    expect(email.toLowerCase()).toBe("abc123@e.ntu.edu.sg");
    expect(exp).toBe(Math.floor(Date.now() / 1000) + 90 * 86_400);
  });

  it("uses the owner email it is given", async () => {
    const jwt = await new Daikin(null, fakeFetch("Zed9@e.ntu.edu.sg")).exchange("hash");
    expect(jwtClaims(jwt).email).toBe("ZED9@e.ntu.edu.sg");
  });

  it("applies a control change only after 4 seconds", async () => {
    const d = await signedIn();
    expect((await d.me()).aircon).toMatchObject({ power: 0, setpoint: 24 });

    await d.control({ power: 1, setpoint: 23 });
    vi.advanceTimersByTime(3999);
    expect((await d.me()).aircon).toMatchObject({ power: 0, setpoint: 24 });

    vi.advanceTimersByTime(1);
    expect((await d.me()).aircon).toMatchObject({ power: 1, setpoint: 23 });
  });

  it("accepts an injected clock", async () => {
    let t = 1_000_000;
    const fetcher = fakeFetch("abc123@e.ntu.edu.sg", () => t);
    const d = new Daikin(await new Daikin(null, fetcher).exchange("hash"), fetcher);
    await d.control({ mode: "F", fanstep: "MH", flap: "S" });
    expect((await d.me()).aircon).toMatchObject({ mode: "C", fanstep: "A", flap: "N" });
    t += 4000;
    expect((await d.me()).aircon).toMatchObject({ mode: "F", fanstep: "MH", flap: "S" });
  });

  it("holds the hall controller floor of 22", async () => {
    const d = await signedIn();
    await d.control({ setpoint: 18 });
    vi.advanceTimersByTime(4000);
    expect((await d.me()).aircon?.setpoint).toBe(22);
  });

  it("answers me with the owner's email and balance", async () => {
    const me = await (await signedIn("abc123@e.ntu.edu.sg")).me();
    expect(me.email).toBe("ABC123@e.ntu.edu.sg");
    expect(me.balance).toBe(10);
  });

  it("answers 402 without a Bearer token", async () => {
    await expect(new Daikin(null, fakeFetch()).me()).rejects.toBeInstanceOf(DaikinExpired);
  });

  it("serves usage with a total and paging", async () => {
    const d = await signedIn();
    const first = await d.usage(5, 0);
    expect(first.rows).toHaveLength(5);
    expect(first.total).toBe(12);
    expect((await d.usage(5, 10)).rows).toHaveLength(2);
    expect(first.rows[0]).toMatchObject({ endtime: expect.stringContaining("+08:00"), duration: 480 });
  });

  it("serves history, notifications, config and faq", async () => {
    const d = await signedIn();
    expect(await d.topups(10, 0)).toHaveLength(2);
    expect(await d.notifications(10, 0)).toHaveLength(2);
    expect(await d.config("temperature_allowed_min")).toMatchObject({ value: 22 });
    expect(await d.config("temperature_allowed_max")).toMatchObject({ value: 26 });
    expect(await d.config("payment_dominations")).toMatchObject({
      value: [10, 20, 30, 40, 50].map((amount) => ({ amount, enable: true })),
    });
    await expect(d.config("nope")).rejects.toMatchObject({ status: 404 });
    expect(await d.faq()).toBeInstanceOf(Array);
    await d.pair("H11-12-34-5678-02");
    await d.makeDefault("H11-12-34-5678-02");
    expect((await d.me()).aircon?.aircon_code).toBe("H11-12-34-5678-02");
  });

  it("PayNow returns a PNG data URL and VisaMaster a placeholder https URL", async () => {
    const d = await signedIn();
    const pay = await d.topup(10, "PayNow");
    expect(pay.qrcode).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    const bytes = Uint8Array.from(atob(pay.qrcode!.split(",")[1]), (c) => c.charCodeAt(0));
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const card = await d.topup(20, "VisaMaster");
    expect(card.payment_url).toBe("https://example.invalid/enets");
    await expect(d.topup(15, "PayNow")).rejects.toMatchObject({ status: 422 });
  });

  it("still works when the client passes an abort signal (fake timers on)", async () => {
    const d = await signedIn();
    expect((await d.me()).balance).toBe(10);
    expect(vi.getTimerCount()).toBe(0); // the client cleared its deadline timer
  });

  it("never reaches the network", async () => {
    const real = vi.spyOn(globalThis, "fetch");
    await (await signedIn()).me();
    expect(real).not.toHaveBeenCalled();
  });
});
