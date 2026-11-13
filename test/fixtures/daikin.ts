import { http, HttpResponse } from "msw";
import type { Aircon, Me } from "../../src/do/daikin";

export const DAIKIN = "https://apintu-prod.daikinpayu.com";

/** The real `Aircon` plus the extra fields Daikin sends that the client does not model. */
export type FullAircon = Omit<Aircon, "room"> & { room: { room_name: string; id: number } } & Record<string, unknown>;
export type MeData = Me & { aircon: FullAircon } & Record<string, unknown>;

const b64url = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Unsigned `header.payload.sig` JWT. `exp` is seconds since epoch (default: +1 day). */
export function fakeJwt({
  email,
  exp = Math.floor(Date.now() / 1000) + 86_400,
}: {
  email: string;
  exp?: number;
}): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ email, exp }));
  return `${header}.${payload}.sig`;
}

/** Realistic `/me` `data` object (shape from ENDPOINTS.md section 2.1). */
export function meData(over: Partial<FullAircon> = {}): MeData {
  return {
    room_id: 4141,
    user_id: 100001,
    residence_id: "U0000000X",
    firstname: "Tan",
    lastname: "Ah Kow",
    email: "ABC123@e.ntu.edu.sg",
    balance: 10,
    notification: 30,
    aircon: {
      id: 4242,
      aircon_code: "H11-12-34-5678-01",
      aircon_type: 1,
      status: true,
      current_temperature: 26,
      power: 0,
      mode: "C",
      maintenance_mode: 0,
      comm_stat: 1,
      default_account: 100001,
      setpoint: 22,
      flap: "N",
      fanstep: "A",
      hall: { hall_name: "Hall 11" },
      room: { room_name: "H11-12-34-5678", id: 4141 },
      ...over,
    },
    account: { residence_id: "U0000000X" },
    wallet: null,
  };
}

/** Full `/me` response body as Daikin sends it: `{ meta, data }`. */
export function meBody(over: Partial<FullAircon> = {}): {
  meta: { status: 200 };
  data: MeData;
} {
  return { meta: { status: 200 }, data: meData(over) };
}

/** Default MSW handlers for Daikin. Add per test with `network.use(...daikin)`. */
export const daikin = [
  http.get(`${DAIKIN}/me`, () => HttpResponse.json(meBody())),
  http.post(`${DAIKIN}/v2/ac/control`, () =>
    HttpResponse.json({
      meta: { status: 200, message: "Successfully control aircon." },
    }),
  ),
];
