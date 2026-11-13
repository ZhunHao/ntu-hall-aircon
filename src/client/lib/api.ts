import type { Problem } from "../../shared/schedule";

/** A non-2xx answer from `/api/*`. `error` is the Worker's short code, e.g. "rate-limited". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly problems?: Problem[],
  ) {
    super(error);
    this.name = "ApiError";
  }
}

interface Loc {
  pathname: string;
  assign(url: string): void;
}

/** The part of `RequestInit` that `api()` uses. No `mode`: the default keeps `Origin` on POST/PUT. */
export interface ApiInit {
  method: string;
  credentials: "same-origin";
  headers?: Record<string, string>;
  body?: string;
}

export interface ApiDeps {
  fetch: (url: string, init: ApiInit) => Promise<Response>;
  location: () => Loc;
}

// Workers static assets serve signin.html at the clean URL /signin (and redirect /signin.html there).
const SIGNIN = "/signin";
const SIGNIN_PATHS = new Set(["/signin", "/signin.html"]);

/** Builds `api()` over injectable `fetch` and `location` (the tests use fakes). */
export function createApi(deps: ApiDeps) {
  return async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    // Default fetch mode: the Worker needs the browser to send `Origin` on POST/PUT.
    const init: ApiInit = { method, credentials: "same-origin" };
    if (method !== "GET") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body ?? {});
    }

    let res: Response;
    try {
      res = await deps.fetch(path, init);
    } catch {
      throw new ApiError(0, "network");
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }

    if (res.ok) return data as T;

    const obj = data && typeof data === "object" ? (data as { error?: unknown; problems?: unknown }) : {};
    const error = typeof obj.error === "string" ? obj.error : "failed";
    const problems = Array.isArray(obj.problems) ? (obj.problems as Problem[]) : undefined;

    if (res.status === 401) {
      const loc = deps.location();
      if (!SIGNIN_PATHS.has(loc.pathname)) loc.assign(error === "expired" ? `${SIGNIN}#expired` : SIGNIN);
    }
    throw new ApiError(res.status, error, problems);
  };
}

/** Calls the Worker API. A 401 sends the resident to the sign-in page (and still throws). */
export const api = createApi({
  fetch: (url, init) => fetch(url, init),
  location: () => (globalThis as unknown as { location: Loc }).location,
});
