import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { network } from "./network";
import { DAIKIN, daikin, type meBody } from "./fixtures/daikin";

it("unknown API route is a JSON 404", async () => {
  const r = await exports.default.fetch("https://x.test/api/nope");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "not-found" });
});

it("MSW network answers a mocked Daikin call", async () => {
  network.use(...daikin);
  const r = await fetch(`${DAIKIN}/me`);
  const body = (await r.json()) as ReturnType<typeof meBody>;
  expect(body.data.aircon.aircon_code).toBe("H11-12-34-5678-01");
  expect(body.data.email).toBe("ABC123@e.ntu.edu.sg");
});

it("MSW errors on an unhandled outbound request", async () => {
  await expect(fetch(`${DAIKIN}/me`)).rejects.toThrow(/MSW/);
});
