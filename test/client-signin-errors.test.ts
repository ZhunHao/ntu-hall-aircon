import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/lib/api";
import { signinOutcome } from "../src/client/lib/signin-errors";

const err = (status: number, code: string) => new ApiError(status, code);

describe("signinOutcome", () => {
  it("shows the rejected screen for a rejected code", () => {
    expect(signinOutcome(err(400, "rejected"), "x")).toEqual({ screen: "rejected" });
  });

  it("explains another owner, rate limit and missing config", () => {
    expect(signinOutcome(err(400, "not-owner"), "x")).toEqual({
      screen: "error",
      message: "This copy belongs to another NTU account.",
    });
    expect(signinOutcome(err(429, "rate-limited"), "x")).toEqual({
      screen: "error",
      message: "Too many tries. Wait 10 minutes and try again.",
    });
    expect(signinOutcome(err(500, "not-configured"), "x")).toEqual({
      screen: "error",
      message: "This copy isn't set up yet. Check OWNER_EMAIL and SESSION_SECRET in your Cloudflare settings.",
    });
  });

  it("uses the parser's copy for no-code", () => {
    expect(signinOutcome(err(400, "no-code"), "/adfs/saml/redirect/Ab12")).toEqual({
      screen: "error",
      message: "The code looks cut off. Copy the whole address again.",
    });
  });

  it("falls back to a generic retry message for network and unknown errors", () => {
    const generic = { screen: "error", message: "Couldn't sign you in. Check your connection and try again." };
    expect(signinOutcome(err(0, "network"), "x")).toEqual(generic);
    expect(signinOutcome(err(502, "failed"), "x")).toEqual(generic);
    expect(signinOutcome(new TypeError("boom"), "x")).toEqual(generic);
    expect(signinOutcome(err(400, "no-code"), "")).toEqual(generic);
  });
});
