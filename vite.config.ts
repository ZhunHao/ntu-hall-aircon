import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (name: string) => fileURLToPath(new URL(`./src/client/${name}.html`, import.meta.url));

// The browser app. `wrangler.jsonc` serves dist/client as static assets; src/client/public/_headers
// ships to dist/client/_headers with the CSP and the other security headers.
export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    // The CSP is script-src 'self' and font-src 'self': nothing may be inlined into the HTML or as data: URLs.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        index: page("index"),
        signin: page("signin"),
        schedule: page("schedule"),
        history: page("history"),
        settings: page("settings"),
      },
    },
  },
  server: {
    // `wrangler dev` listens on 8787 by default. Host is not rewritten, so the Worker sees the same
    // origin as the browser's Origin header and the POST check passes.
    proxy: { "/api": "http://localhost:8787" },
  },
});
