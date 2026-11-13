// Sign-in paste parser. Pure: the sign-in page uses it, and the Durable Object re-checks the pasted text.

// The code is base64 and may contain "/", "+" and "=", so take everything after /adfs/saml/redirect/
export function extractCode(text: string): { code: string } | { error: string } {
  if (!text) return { error: "" };
  let t = text.trim();
  try {
    t = decodeURIComponent(t);
  } catch {}
  const m = t.match(/\/adfs\/saml\/redirect\/([A-Za-z0-9+/=_-]+)/);
  if (m) return m[1].length >= 16 ? { code: m[1] } : { error: "The code looks cut off. Copy the whole address again." };
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(t)) return { code: t };
  if (/daikinpayu|loginfs\.ntu/.test(t))
    return { error: "That's an address from the sign-in page, not the error page after it. Finish signing in first." };
  return { error: "Couldn't find a sign-in code. Paste the address of the “Cannot GET” page." };
}
