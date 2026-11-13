import mobileStyles from "@awesome.me/webawesome/dist/components/page/page.mobile.styles.js";
import { describe, expect, it } from "vitest";
import headers from "../src/client/public/_headers?raw";
import shellSource from "../src/client/lib/shell?raw";

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function rule(name: string): string {
  const line = headers.split("\n").find((l) => l.trim().toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (!line) throw new Error(`_headers has no ${name}`);
  return line.slice(line.indexOf(":") + 1).trim();
}

describe("_headers", () => {
  it("applies to every path and sets the three security headers", () => {
    expect(headers.split("\n")[0]).toBe("/*");
    expect(rule("X-Content-Type-Options")).toBe("nosniff");
    expect(rule("Referrer-Policy")).toBe("no-referrer");
    expect(rule("Content-Security-Policy")).toContain("default-src 'self'");
  });

  // <wa-page> injects `<style id="mobile-styles">` into its shadow root, and `style-src 'self'` blocks
  // inline styles, so the CSP allows exactly that text by hash. The text is the template in Web Awesome's
  // page component (mobile-breakpoint="870" becomes "870px"). If a Web Awesome upgrade changes it, this fails:
  // read the new text from `document.querySelector("wa-page").shadowRoot.querySelector("#mobile-styles")`
  // in a browser, then update the hash in _headers.
  it("allows wa-page's injected style by its sha256 hash", async () => {
    const injected = `\n          ${mobileStyles("870px")}\n        `;
    const hash = await sha256Base64(injected);
    const styleSrc = rule("Content-Security-Policy")
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("style-src "));
    expect(styleSrc).toBe(`style-src 'self' 'sha256-${hash}'`);
  });

  it("the shell uses the 870px breakpoint the hash was computed for", () => {
    expect(shellSource).toContain('setAttribute("mobile-breakpoint", "870")');
  });
});
