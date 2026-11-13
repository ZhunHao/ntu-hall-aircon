import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/lib/api";
import {
  pairedRoom,
  pairErrorText,
  parsePairCode,
  PAIR_CODE_HELP,
  roomAccountConfirm,
  apiErrorText,
  SIGNOUT_CONFIRM,
} from "../src/client/lib/settings-logic";
import type { MeView } from "../src/shared/api";

const me = (aircon: Partial<NonNullable<MeView["aircon"]>> | null): MeView => ({
  email: "abc123@e.ntu.edu.sg",
  firstname: "Fake",
  balance: 10,
  aircon: aircon === null ? null : ({ room: { room_name: "H11-12-34-5678" }, default_account: false, ...aircon } as MeView["aircon"]),
});

describe("parsePairCode", () => {
  it("trims and upper-cases a good code", () => {
    expect(parsePairCode("  h11-12-34-5678-01 ")).toEqual({ ok: true, code: "H11-12-34-5678-01" });
  });
  it("accepts any hall number of digits", () => {
    expect(parsePairCode("H2-01-02-0003-04")).toEqual({ ok: true, code: "H2-01-02-0003-04" });
  });
  it.each(["", "   ", "H11-12-34-5678", "11-12-34-5678-01", "H11-2-34-5678-01", "H11-12-34-5678-01x", "H11 12 34 5678 01", "HX-12-34-5678-01"])(
    "rejects %j with the help text",
    (raw) => {
      expect(parsePairCode(raw)).toEqual({ ok: false, message: PAIR_CODE_HELP });
    },
  );
});

describe("copy", () => {
  it("room account confirm uses the exact wording and names the room", () => {
    expect(roomAccountConfirm("H11-12-34-5678")).toBe(
      "This makes you the Room Account holder for H11-12-34-5678: the physical remote will bill your wallet. It can't be removed, only handed to someone else.",
    );
  });
  it("sign out confirm", () => {
    expect(SIGNOUT_CONFIRM).toBe("Your schedule stops until you sign in again.");
  });
});

describe("pairedRoom", () => {
  it("is the room name when paired", () => {
    expect(pairedRoom(me({}))).toBe("H11-12-34-5678");
  });
  it("is null when unpaired or not loaded", () => {
    expect(pairedRoom(me(null))).toBeNull();
    expect(pairedRoom(null)).toBeNull();
  });
});

describe("apiErrorText", () => {
  it("shows the validation message for a bad pair code", () => {
    expect(apiErrorText(new ApiError(400, "invalid-code"))).toBe(PAIR_CODE_HELP);
  });
  it("blames Daikin for a 502", () => {
    expect(apiErrorText(new ApiError(502, "daikin"))).toBe("Daikin didn't respond. Try again.");
  });
  it("asks to pair first when there is no aircon", () => {
    expect(apiErrorText(new ApiError(400, "not-paired"))).toBe("Pair your room first.");
  });
  it("explains a lost connection", () => {
    expect(apiErrorText(new ApiError(0, "network"))).toBe("No connection. Check your internet and try again.");
  });
  it("falls back to a generic line", () => {
    expect(apiErrorText(new ApiError(500, "boom"))).toBe("Something went wrong. Try again.");
    expect(apiErrorText(new Error("x"))).toBe("Something went wrong. Try again.");
  });
  it("says nothing for a 401 (the page is already moving to sign-in)", () => {
    expect(apiErrorText(new ApiError(401, "signed-out"))).toBeNull();
  });
});

describe("pairErrorText", () => {
  it("says Daikin did not accept the code when Daikin answers 502", () => {
    expect(pairErrorText(new ApiError(502, "daikin"))).toBe(
      "Daikin didn't accept that code. Check it against the one on your aircon and try again.",
    );
  });
  it("keeps the shared wording for everything else", () => {
    expect(pairErrorText(new ApiError(400, "invalid-code"))).toBe(PAIR_CODE_HELP);
    expect(pairErrorText(new ApiError(0, "network"))).toBe("No connection. Check your internet and try again.");
    expect(pairErrorText(new ApiError(401, "signed-out"))).toBeNull();
  });
});
