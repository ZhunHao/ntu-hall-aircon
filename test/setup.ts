import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./network";

// Any outbound request without a matching handler must fail the test, so the
// real Daikin API can never be reached. `@msw/cloudflare` exposes this as
// `onUnhandledFrame` on `network.configure()` (not msw/node's `onUnhandledRequest`).
network.configure({ onUnhandledFrame: "error" });

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
