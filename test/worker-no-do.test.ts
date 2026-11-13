import { listDurableObjectIds } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

// This file must never sign in: it proves that requests without a session cookie never wake the Durable Object (S1).
const ORIGIN = "https://x.test";

it("answers cookie-less requests without instantiating the Durable Object", async () => {
  const me = await exports.default.fetch(`${ORIGIN}/api/me`);
  expect(me.status).toBe(401);
  expect(await me.json()).toEqual({ error: "signed-out" });

  const session = await exports.default.fetch(`${ORIGIN}/api/session`);
  expect(await session.json()).toEqual({ valid: false });

  const empty = await exports.default.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: "ha_session=" } });
  expect(empty.status).toBe(401);

  // Junk cookies (wrong length or alphabet) are rejected locally too.
  for (const junk of ["x", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, "../etc"]) {
    const r = await exports.default.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: `ha_session=${junk}` } });
    expect(r.status, junk).toBe(401);
    const s = await exports.default.fetch(`${ORIGIN}/api/session`, { headers: { Cookie: `ha_session=${junk}` } });
    expect(await s.json(), junk).toEqual({ valid: false });
  }

  const control = await exports.default.fetch(`${ORIGIN}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: "{}",
  });
  expect(control.status).toBe(401);

  expect((await exports.default.fetch(`${ORIGIN}/api/nope`)).status).toBe(404);

  const big = await exports.default.fetch(`${ORIGIN}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ text: "a".repeat(10_240) }),
  });
  expect(big.status).toBe(413);

  expect(await listDurableObjectIds(env.HOME)).toEqual([]);
});
