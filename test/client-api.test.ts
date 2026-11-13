import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type ApiInit } from "../src/client/lib/api";

function setup(res: Response | Error, pathname = "/") {
  const fetch = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  const assign = vi.fn();
  const api = createApi({ fetch, location: () => ({ pathname, assign }) });
  return { api, fetch, assign };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api()", () => {
  it("GET sends no body or content type and returns the JSON", async () => {
    const { api, fetch } = setup(json({ valid: true }));
    expect(await api("GET", "/api/session")).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith("/api/session", { method: "GET", credentials: "same-origin" });
  });

  it("POST sends a JSON content type and `{}` when there is no body", async () => {
    const { api, fetch } = setup(json({ ok: true }));
    await api("POST", "/api/signout");
    const [, init] = fetch.mock.calls[0] as unknown as [string, ApiInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe("{}");
    expect(init.credentials).toBe("same-origin");
    expect("mode" in init).toBe(false);
  });

  it("PUT sends the body as JSON", async () => {
    const { api, fetch } = setup(json({ ok: true }));
    await api("PUT", "/api/schedule", { periods: [1] });
    const [, init] = fetch.mock.calls[0] as unknown as [string, ApiInit];
    expect(init.body).toBe('{"periods":[1]}');
  });

  it("401 signed-out goes to the sign-in page and throws", async () => {
    const { api, assign } = setup(json({ error: "signed-out" }, 401));
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 401, error: "signed-out" });
    expect(assign).toHaveBeenCalledWith("/signin");
  });

  it("401 expired goes to /signin#expired", async () => {
    const { api, assign } = setup(json({ error: "expired" }, 401));
    await expect(api("GET", "/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith("/signin#expired");
  });

  it.each(["/signin", "/signin.html"])("does not redirect when already on %s", async (pathname) => {
    const { api, assign } = setup(json({ error: "signed-out" }, 401), pathname);
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it("other errors throw with the code and problems, without redirecting", async () => {
    const problems = [{ code: "overlap", message: "x" }];
    const { api, assign } = setup(json({ error: "invalid", problems }, 400));
    await expect(api("PUT", "/api/schedule", {})).rejects.toMatchObject({
      status: 400,
      error: "invalid",
      problems,
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("a non-JSON error body still throws an ApiError", async () => {
    const { api } = setup(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 502, error: "failed" });
  });

  it("a network failure throws status 0", async () => {
    const { api } = setup(new TypeError("offline"));
    await expect(api("GET", "/api/me")).rejects.toMatchObject({ status: 0, error: "network" });
  });
});
