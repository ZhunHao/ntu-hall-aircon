/** Small HTTP helpers for the Worker. Nothing here logs request data. */

export const COOKIE = "ha_session";
export const MAX_BODY = 8 * 1024;

const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** A JSON response with the security headers every `/api/*` answer carries. */
export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

/** The value of one cookie from the `Cookie` header, or undefined when absent or empty. */
export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** `Set-Cookie` value for the session cookie. `maxAgeS = 0` clears it. */
export function sessionCookie(value: string, maxAgeS: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeS))}`;
}

/** True when `Content-Type` is `application/json`, with or without parameters such as `; charset=utf-8`. */
export function isJsonRequest(req: Request): boolean {
  const type = req.headers.get("Content-Type");
  return type !== null && type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** True when the `Origin` header is exactly the request's own origin. A missing Origin is not same-origin. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin === new URL(req.url).origin;
}

export type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: "too-large" | "bad-json" };

/**
 * Read the request body as JSON, refusing more than `max` bytes. Both `Content-Length` and the bytes
 * actually read are checked, so a lying or absent length cannot get past the limit. An empty body is
 * `value: undefined`.
 */
export async function readJsonLimited(req: Request, max = MAX_BODY): Promise<Body> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && Number(declared) > max) return { ok: false, status: 413, error: "too-large" };
  if (!req.body) return { ok: true, value: undefined };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { ok: false, status: 413, error: "too-large" };
    }
    chunks.push(value);
  }
  if (size === 0) return { ok: true, value: undefined };

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "bad-json" };
  }
}
