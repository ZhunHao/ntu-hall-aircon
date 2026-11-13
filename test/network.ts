import { setupNetwork } from "@msw/cloudflare";

// One shared MSW network for all tests. Register per-test handlers with
// `network.use(...)`; unhandled outbound requests fail (see test/setup.ts).
export const network = setupNetwork();
