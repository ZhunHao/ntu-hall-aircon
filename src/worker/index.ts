import type { Home } from "../do/home";
import { sha256Hex } from "../do/crypto";
import type { ApiResult } from "../shared/api";
import { accessMisconfigured, verifyAccess } from "./access";
import { getCookie, isJsonRequest, json, readJsonLimited, sameOrigin, sessionCookie, COOKIE } from "./http";

export { Home } from "../do/home";

export interface Env {
  HOME: DurableObjectNamespace<Home>;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  OWNER_EMAIL: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DAIKIN_FAKE?: string;
}

const MAX_SIGNIN_TEXT = 4096;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const SIGNOUT_COOKIE = sessionCookie("", 0);

/** What a route handler gets. `body` is the parsed JSON (undefined when empty) of a non-GET request. */
interface Call {
  env: Env;
  url: URL;
  body: unknown;
  home: DurableObjectStub<Home>;
  /** SHA-256 of the `ha_session` cookie; undefined when the request has none. */
  tokenHash: string | undefined;
  ip: string;
  /** The dev fake is honoured only for a `localhost` or `127.0.0.1` request (S6). */
  fake: boolean;
}

type Handler = (c: Call) => Promise<Response>;

interface Route {
  /** `none`: no session involved, `soft`: the handler answers for a missing session itself, `required`: 401 without one. */
  auth: "none" | "soft" | "required";
  methods: Partial<Record<"GET" | "POST" | "PUT", Handler>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** ApiResult to HTTP: ok is 200 with the data, otherwise its status with `{ error }`. */
function result<T>(r: ApiResult<T>): Response {
  return r.ok ? json(r.data) : json({ error: r.error }, r.status);
}

/** An integer query value, `fallback` when absent, undefined when it is not an integer. */
function intParam(url: URL, name: string, fallback: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

/** `?limit&offset` for paged history; the Durable Object checks the ranges. */
function paged(fn: (home: DurableObjectStub<Home>, limit: number, offset: number) => Promise<Response>): Handler {
  return async (c) => {
    const limit = intParam(c.url, "limit", 20);
    const offset = intParam(c.url, "offset", 0);
    if (limit === undefined || offset === undefined) return json({ error: "invalid-page" }, 400);
    return fn(c.home, limit, offset);
  };
}

const ROUTES: Record<string, Route> = {
  "/api/signin": {
    auth: "none",
    methods: {
      POST: async (c) => {
        const text = isRecord(c.body) ? c.body.text : undefined;
        if (typeof text !== "string" || text.length > MAX_SIGNIN_TEXT) return json({ error: "invalid" }, 400);
        const r = await c.home.signIn(text, c.ip, c.fake);
        if (!r.ok) {
          const status = r.error === "not-configured" ? 500 : r.error === "rate-limited" ? 429 : 400;
          return json({ error: r.error }, status);
        }
        return json({ ok: true, expiresMs: r.expiresMs }, 200, {
          "Set-Cookie": sessionCookie(r.token, (r.expiresMs - Date.now()) / 1000),
        });
      },
    },
  },
  "/api/signout": {
    auth: "required",
    methods: {
      POST: async (c) => {
        await c.home.signOut();
        return json({ ok: true }, 200, { "Set-Cookie": SIGNOUT_COOKIE });
      },
    },
  },
  "/api/session": {
    auth: "soft",
    methods: { GET: async (c) => json(c.tokenHash === undefined ? { valid: false } : await c.home.session(c.tokenHash)) },
  },
  "/api/me": { auth: "required", methods: { GET: async (c) => result(await c.home.me()) } },
  "/api/control": { auth: "required", methods: { POST: async (c) => result(await c.home.control(c.body)) } },
  "/api/usage": {
    auth: "required",
    methods: { GET: paged(async (h, l, o) => result(await h.usage(l, o))) },
  },
  "/api/topups": {
    auth: "required",
    methods: { GET: paged(async (h, l, o) => result(await h.topups(l, o))) },
  },
  "/api/notifications": {
    auth: "required",
    methods: { GET: paged(async (h, l, o) => result(await h.notifications(l, o))) },
  },
  "/api/config": { auth: "required", methods: { GET: async (c) => result(await c.home.config()) } },
  "/api/pair": {
    auth: "required",
    methods: {
      POST: async (c) => {
        const code = isRecord(c.body) ? c.body.code : undefined;
        if (typeof code !== "string") return json({ error: "invalid-code" }, 400);
        return result(await c.home.pair(code));
      },
    },
  },
  "/api/room-account": { auth: "required", methods: { POST: async (c) => result(await c.home.roomAccount()) } },
  "/api/topup": {
    auth: "required",
    methods: {
      POST: async (c) => {
        const amount = isRecord(c.body) ? c.body.amount : undefined;
        const type = isRecord(c.body) ? c.body.type : undefined;
        if (typeof amount !== "number" || typeof type !== "string") return json({ error: "invalid-topup" }, 400);
        return result(await c.home.topup(amount, type));
      },
    },
  },
  "/api/schedule": {
    auth: "required",
    methods: {
      GET: async (c) => json(await c.home.getSchedule()),
      PUT: async (c) => {
        const r = await c.home.putSchedule(c.body);
        return r.ok ? json({ ok: true }) : json({ error: "invalid", problems: r.problems }, 400);
      },
    },
  },
  "/api/schedule/apply-now": { auth: "required", methods: { POST: async (c) => result(await c.home.applyNow()) } },
  "/api/activity": {
    auth: "required",
    methods: {
      GET: async (c) => {
        const limit = intParam(c.url, "limit", 50);
        if (limit === undefined) return json({ error: "invalid-page" }, 400);
        return json(await c.home.activity(limit));
      },
    },
  },
};

const signedOut = (): Response => json({ error: "signed-out" }, 401);

async function handleApi(request: Request, env: Env): Promise<Response> {
  // 3. Route match. Unknown paths are 404 before any session check; a known path with a wrong method is 405.
  const url = new URL(request.url);
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
  if (!route) return json({ error: "not-found" }, 404);
  const method = request.method;
  const handler = method === "GET" || method === "POST" || method === "PUT" ? route.methods[method] : undefined;
  if (!handler) return json({ error: "method" }, 405, { Allow: Object.keys(route.methods).join(", ") });

  // 4. CSRF on anything that changes state.
  let body: unknown;
  if (method !== "GET") {
    if (!isJsonRequest(request) || !sameOrigin(request)) return json({ error: "bad-origin" }, 403);

    // 5. Body size, before any Durable Object call.
    const read = await readJsonLimited(request);
    if (!read.ok) return json({ error: read.error }, read.status);
    body = read.value;
  }

  // 6. Session. No cookie never reaches the Durable Object.
  // Tokens are always 43 base64url characters; anything else is junk and never reaches the Durable Object.
  const cookie = getCookie(request, COOKIE);
  const tokenHash = cookie !== undefined && TOKEN_SHAPE.test(cookie) ? await sha256Hex(cookie) : undefined;
  const home = env.HOME.getByName("home");
  if (route.auth === "required") {
    if (tokenHash === undefined || !(await home.session(tokenHash)).valid) return signedOut();
  }

  const fake =
    env.DAIKIN_FAKE === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return handler({ env, url, body, home, tokenHash, ip: request.headers.get("CF-Connecting-IP") ?? "unknown", fake });
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    // Cloudflare Access applies to every request that reaches the Worker, /api or not:
    // half-configured fails closed; fully configured needs a valid assertion.
    if (accessMisconfigured(env)) return json({ error: "access-misconfigured" }, 403);
    if (!(await verifyAccess(request, env))) return json({ error: "access" }, 403);

    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        // Never log the request, only the error's class.
        console.error("api failed:", e instanceof Error ? e.name : "unknown");
        return json({ error: "server" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
