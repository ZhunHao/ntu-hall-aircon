import { ApiError } from "./api";
import { extractCode } from "../../shared/signin";

/** What the sign-in page does with a failed `POST /api/signin`. */
export type SigninOutcome = { screen: "rejected" } | { screen: "error"; message: string };

const GENERIC = "Couldn't sign you in. Check your connection and try again.";

/** Maps a failed sign-in to a screen. `text` is what was pasted, used only for the parser's own wording. */
export function signinOutcome(err: unknown, text: string): SigninOutcome {
  if (!(err instanceof ApiError)) return { screen: "error", message: GENERIC };
  switch (err.error) {
    case "rejected":
      return { screen: "rejected" };
    case "not-owner":
      return { screen: "error", message: "This copy belongs to another NTU account." };
    case "rate-limited":
      return { screen: "error", message: "Too many tries. Wait 10 minutes and try again." };
    case "not-configured":
      return {
        screen: "error",
        message: "This copy isn't set up yet. Check OWNER_EMAIL and SESSION_SECRET in your Cloudflare settings.",
      };
    case "no-code": {
      const parsed = extractCode(text);
      return { screen: "error", message: "error" in parsed && parsed.error ? parsed.error : GENERIC };
    }
    default:
      return { screen: "error", message: GENERIC };
  }
}
