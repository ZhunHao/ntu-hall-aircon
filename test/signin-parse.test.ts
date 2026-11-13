import { describe, expect, it } from "vitest";
import { extractCode } from "../src/shared/signin";

const CODE = "AbCdEf0123456789/xYz+Q==";
const BASE = "https://cmsntu-prod.daikinpayu.com";

describe("extractCode (sign-in paste)", () => {
  it("full URL", () => {
    expect(extractCode(`${BASE}/adfs/saml/redirect/${CODE}`)).toEqual({ code: CODE });
  });

  it("Cannot GET text", () => {
    expect(extractCode(`Cannot GET /adfs/saml/redirect/${CODE}`)).toEqual({ code: CODE });
  });

  it("URL-encoded", () => {
    expect(extractCode(`${BASE}/adfs/saml/redirect/AbCdEf0123456789%2FxYz%2BQ%3D%3D`)).toEqual({ code: CODE });
  });

  it("cut off", () => {
    expect(extractCode(`${BASE}/adfs/saml/redirect/Ab12`)).toEqual({
      error: "The code looks cut off. Copy the whole address again.",
    });
  });

  it("login page instead", () => {
    expect(extractCode("https://loginfs.ntu.edu.sg/adfs/ls/")).toEqual({
      error: "That's an address from the sign-in page, not the error page after it. Finish signing in first.",
    });
  });

  it("empty string", () => {
    expect(extractCode("")).toEqual({ error: "" });
  });
});
