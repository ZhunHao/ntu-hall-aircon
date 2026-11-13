import { ApiError } from "./api";
import type { MeView } from "../../shared/api";

/** The aircon code printed on the unit, e.g. H11-12-34-5678-01 (same pattern the server checks). */
const PAIR_CODE = /^H\d+-\d{2}-\d{2}-\d{4}-\d{2}$/;

export const PAIR_CODE_HELP = "Enter the code on your aircon, like H11-12-34-5678-01.";
export const SIGNOUT_CONFIRM = "Your schedule stops until you sign in again.";

export type PairCode = { ok: true; code: string } | { ok: false; message: string };

/** Trims and upper-cases what was typed, then checks the shape. */
export function parsePairCode(raw: string): PairCode {
  const code = raw.trim().toUpperCase();
  return PAIR_CODE.test(code) ? { ok: true, code } : { ok: false, message: PAIR_CODE_HELP };
}

export function roomAccountConfirm(room: string): string {
  return `This makes you the Room Account holder for ${room}: the physical remote will bill your wallet. It can't be removed, only handed to someone else.`;
}

/** The paired room's name, or null when unpaired or not loaded yet. */
export function pairedRoom(me: MeView | null): string | null {
  return me?.aircon?.room.room_name || null;
}

/** Friendly words for a failed call (History and Settings share it). Null for a 401: the sign-in redirect is already under way. */
export function apiErrorText(err: unknown): string | null {
  if (err instanceof ApiError) {
    if (err.status === 401) return null;
    if (err.status === 0) return "No connection. Check your internet and try again.";
    if (err.error === "invalid-code") return PAIR_CODE_HELP;
    if (err.error === "not-paired") return "Pair your room first.";
    if (err.status === 502) return "Daikin didn't respond. Try again.";
  }
  return "Something went wrong. Try again.";
}

/** Pairing: Daikin answering 502 means it refused the code, so retrying the same code is pointless. */
export function pairErrorText(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 502) {
    return "Daikin didn't accept that code. Check it against the one on your aircon and try again.";
  }
  return apiErrorText(err);
}
