import type * as MainModule from "./worker/index";

// Types `ctx.exports` and `exports` from "cloudflare:workers" (exports.default.fetch)
// and `env` in tests. Same shape that `wrangler types` generates.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: "Home";
    }
    interface Env extends MainModule.Env {}
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends MainModule.Env {}
}
