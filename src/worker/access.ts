import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index";

type Keys = ReturnType<typeof createRemoteJWKSet>;

/** One key set per team domain, so jose's own cache (10 min, with a refetch cooldown) survives across requests. */
const keySets = new Map<string, Keys>();

function keysFor(teamDomain: string): Keys {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

const clean = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/** The team domain as a bare host. Cloudflare's dialog shows `https://<team>.cloudflareaccess.com`, so tolerate a pasted URL. */
const teamOf = (v: string | undefined): string => clean(v).replace(/^https:\/\//i, "").replace(/\/+$/, "").trim();

/** Exactly one of the two Access vars is set: the copy would be half protected, so it must refuse to serve. */
export function accessMisconfigured(env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">): boolean {
  const rawTeam = clean(env.ACCESS_TEAM_DOMAIN);
  // "Set" is decided on the raw value; a value that is only a scheme or slashes is set but unusable.
  if (rawTeam !== "" && teamOf(rawTeam) === "") return true;
  return (rawTeam === "") !== (clean(env.ACCESS_AUD) === "");
}

/**
 * True when Cloudflare Access is off (both vars empty) or the request carries a valid
 * `Cf-Access-Jwt-Assertion` for this team and application. Never throws.
 */
export async function verifyAccess(
  req: Request,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
): Promise<boolean> {
  const rawTeam = clean(env.ACCESS_TEAM_DOMAIN);
  const team = teamOf(rawTeam);
  const aud = clean(env.ACCESS_AUD);
  if (rawTeam === "" && aud === "") return true;
  if (team === "" || aud === "") return false;

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  try {
    await jwtVerify(token, keysFor(team), {
      audience: aud,
      issuer: `https://${team}`,
      algorithms: ["RS256"],
    });
    return true;
  } catch {
    return false;
  }
}
