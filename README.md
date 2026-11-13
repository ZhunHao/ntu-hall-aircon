# NTU Hall Aircon — Web

[![CI](https://github.com/ZhunHao/ntu-hall-aircon/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhunHao/ntu-hall-aircon/actions/workflows/ci.yml)

A browser replacement for the **NTU Hall Aircon** mobile app (`sg.daikin.ntu.ntu_mobile`), for residents who want remote control, schedules and a nicer dashboard **without** building the ESP32 IR hardware from [ntu-hall-ac-scheduler](https://github.com/ZhunHao/ntu-hall-ac-scheduler).

It runs as a single Cloudflare Worker: static UI, a thin proxy to Daikin's hall API, and one Durable Object that keeps your encrypted Daikin login so schedules keep running in the cloud with your browser closed. Each resident deploys **their own copy** to their own Cloudflare account, so nobody else ever holds their login token.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZhunHao/ntu-hall-aircon)

> **Unofficial.** This talks to the same private API the mobile app uses. It is not affiliated with NTU or Daikin, the API can change without notice, and usage on your wallet is billed exactly as if you used the app (S$0.39/h).

---

## Deploy your own

1. Click **Deploy to Cloudflare** above (free Workers plan is enough).
2. Cloudflare clones this repo into your GitHub/GitLab account, asks for a Worker name, then builds and deploys it with Workers Builds.
3. When prompted for `SESSION_SECRET`, paste the output of `openssl rand -hex 32`. It encrypts the Daikin login your copy stores (it is not a cookie). It must be exactly 64 hex characters, or sign-in refuses with "This copy isn't set up yet…".
4. When prompted for `OWNER_EMAIL`, enter your NTU email. Only that account can sign in to your copy.
5. Open `https://<worker-name>.<your-subdomain>.workers.dev` and sign in (see [Signing in](#signing-in)).

Later updates: push to the cloned repo and Workers Builds redeploys automatically.

---

## How it works

```text
Browser ──HTTPS──▶ Your Worker (UI + /api/*) ──▶ https://apintu-prod.daikinpayu.com
                     │  Durable Object keeps the Daikin JWT encrypted; the
                     │  browser only holds an opaque HttpOnly session cookie
                     └─ adds Authorization + Dart User-Agent headers
```

A proxy is required, not optional. Probing the API on 2026-10-30 showed:

- **No CORS.** Responses carry no `Access-Control-Allow-Origin`; `OPTIONS /me` returns `404` and `OPTIONS /v2/ac/control` returns `200` with only `allow: POST`. A browser page on any other origin cannot call the API directly.
- **Unauthenticated requests return `402 {"message":"Unauthorized"}`**, not 401. Treat 402 as "token missing or expired".
- **Rate limit:** `x-ratelimit-limit: 10000` with a reset about 15 minutes out, apparently per client IP. Polling `/me` every 10 s is ~90 requests per 15 min per user, well within it.
- The backend is Express behind Cloudflare and sets a `connect.sid` cookie, which the bearer-token API does not need. Don't forward it.

### Signing in

Login is NTU ADFS (SAML), and the SAML response always lands on Daikin's domain, not ours, so the Worker cannot catch the redirect itself. The flow is:

1. The UI opens `https://cmsntu-prod.daikinpayu.com/adfs/login` in a new tab. This 302s to `loginfs.ntu.edu.sg`.
2. You sign in with your NTU account.
3. ADFS sends you to `https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/<HASH>`. **Copy that full URL** and paste it into the web app.
4. The Worker extracts `<HASH>`, calls `POST /auth/ad/callback` (`hash`, `fcm_token=placeholder`), and stores the returned JWT, encrypted with `SESSION_SECRET`, in your Durable Object. The browser gets only a random session cookie.

The JWT lasts **90 days**. When the API starts returning 402, the UI asks you to sign in again. On the redirect page you will see `Cannot GET /adfs/saml/redirect/<hash>`; that is expected, and the address bar holds what you need. This was verified on desktop and iOS (2026-10-30).

---

## API surface used

Base URL `https://apintu-prod.daikinpayu.com`. Headers: `User-Agent: Dart/3.0 (dart:io)`, `Authorization: Bearer <JWT>`. Request bodies are `application/x-www-form-urlencoded`. Full reverse-engineering notes live in `ENDPOINTS.md` in the scheduler repo.

| Feature | Method & path | Web app |
|---|---|---|
| Profile, balance, live aircon state | `GET /me` | ✅ poll every 10 s while visible |
| Power / setpoint / mode / fan / flap | `POST /v2/ac/control` | ✅ |
| Usage sessions & charges | `GET /usage/history?limit=&offset=` | ✅ |
| Top-up history | `GET /topup/history?limit=&offset=` | ✅ read-only |
| Notifications | `GET /notification?limit=&offset=` | ✅ |
| Limits & config | `GET /app-config/<key>` | ✅ temp min/max, top-up amounts |
| FAQ | `GET /faq` | ✅ |
| Email check / SAML exchange | `POST /auth/ad/verify`, `POST /auth/ad/callback` | ✅ sign-in |
| Logout | `POST /auth/logout` | ➖ not used: sign-out only forgets the login stored in your copy |
| Pair to a room's aircon | `POST /ac/pair` (`code=`) | ✅ type the aircon code, no QR scan needed |
| Become Room Account holder (physical remote) | `POST /ac/default` (`code=`) | ✅ behind a confirm dialog |
| PayNow top-up QR | `POST /topup` (`amount`, `type=PayNow`) | ✅ show the QR; you pay in your bank app |
| Card top-up (eNETS) | `POST /topup` (`amount`, `type=VisaMaster`) | ✅ opens eNETS in a new tab, after showing the Save Card warning below |

### Pairing without the QR

The room QR only carries the aircon code (`H11-XX-XX-XXXX-01`, also shown in `/me` as `aircon.aircon_code`). The app sends it as `code=` to `/ac/pair`, so a text field works just as well as a camera:

- **`/ac/pair`** links your account to that aircon, so app/web control bills your wallet. Pairing to another room's unit moves your control there (the FAQ reminds residents to re-pair when back in their own room).
- **`/ac/default`** makes you the **Room Account** holder, so the **physical remote** bills your wallet. The FAQ says this link cannot be removed, only handed to someone else, which is why the UI confirms first.
- The API doesn't appear to check you're physically in the room, so the UI should show the room name returned by the API before confirming a code.

### Top-up

- **PayNow:** `/topup` returns a base64 PNG SGQR (`data.qrcode`) valid for **15 minutes**. Creating it charges nothing. You confirm the payment in your banking app, DBS notifies the backend, and the new balance appears in `GET /me`. An unused QR just expires. Amounts are S$10–50 in S$10 steps (from `/app-config/payment_dominations`).
- **Card:** returns an eNETS `payment_url` to open in a new tab. On the eNETS page, **untick "Save Card"**. It's ticked automatically when you type a card number, and once a card token is saved, every later card top-up is locked to that card, with no way to remove it from the app.

### Control parameters (`POST /v2/ac/control`)

| Field | Values | Notes |
|---|---|---|
| `power` | `1` on, `0` off | |
| `setpoint` | integer °C | App UI allows 22–26 (from `/app-config`). Values < 22 get `200 OK` but the unit stays at 22; 27–28 are accepted. |
| `mode` | `C` cool, `F` fan, `A` auto, `D` dry | |
| `fanstep` | `A`, `L`, `LM`, `M`, `MH`, `H` | 5 manual levels; the official app only shows 3. |
| `flap` | `N` fixed, `S` swing | |

`GET /me` reflects a change **~4–6 s** after the control call returns, so the UI should show an optimistic "pending" state instead of re-reading right away. The legacy `POST /ac/control` (v1) returns `500 "Please upgrade to the latest version"`.

Useful `aircon` fields from `/me`: `power`, `setpoint`, `mode`, `fanstep`, `flap`, `current_temperature`, `comm_stat` (1 = unit online), `maintenance_mode`, `default_account`.

### House rules to surface in the UI (from `/faq`)

- S$0.39/hour (S$0.0065/min), rounded up per session.
- Daikin's hall system switches every aircon off at **11:00 daily** and when the balance hits S$0. In usage history the 11:00 cut-off ends sessions at 11:00:03–11:00:09, so when a schedule period runs past 11:00 the app checks at 11:01 and switches it back on only if Daikin's hall system cut it. Residents who want it to stop just set the period's off time to 11:00.
- Low-balance alert below S$3. Wallet cap S$50, top-ups in S$10 steps.

### Schedules

Schedules switch your aircon on and off for you. They run in the cloud, so they keep working with your browser closed, using the login stored in your Durable Object. Periods are nights (noon to noon) or days. Daikin's hall system switches every aircon off at 11:00; the app turns it back on at 11:01 only if Daikin cut it. To opt out, end a period at 11:00.

---

## Extra protection: Cloudflare Access (optional)

Cloudflare Access is the way to keep strangers from reaching the URL at all. It is optional and free, but Cloudflare asks for a card when you first set up Zero Trust. The same steps are in the app under **Settings**.

1. In Cloudflare, open **Workers & Pages**, pick this Worker, go to **Settings** then **Domains & Routes**, and click **Enable Cloudflare Access** next to workers.dev. Choose who can sign in (your own email).
2. Copy the team domain and the application audience (AUD) tag that Cloudflare shows. Paste the team domain without `https://`, like `your-team.cloudflareaccess.com`.
3. In the same Worker, go to **Settings** then **Variables and Secrets** and add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (type Text or Secret). From then on the Worker also checks Cloudflare's token on every request that reaches it (all of `/api/*`). Later deploys keep them: they are not in `wrangler.jsonc`'s `vars`, and `keep_vars` is on.

- With Access on, static pages are protected by Access at Cloudflare's edge. The Worker itself only checks `/api/*` and any request that reaches it.
- `ACCESS_TEAM_DOMAIN` is the bare team domain. A pasted `https://` is tolerated.
- Setting only one of the two variables makes every request that reaches the Worker (all of `/api/*`) return 403, on purpose, so a half-protected copy can't be used. The pages themselves are static and still load.

---

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in. Even with the fake, `SESSION_SECRET` must be a real 64-hex key (`openssl rand -hex 32`) and `OWNER_EMAIL` must not be the example's placeholder, or sign-in answers "not set up yet". Add `DAIKIN_FAKE=1` to use the built-in fake Daikin (it works only on localhost, so it can never run on a deployed copy). Then:

```sh
npm run build
npx wrangler dev
```

Or `npm run dev`, which rebuilds the UI on every change while `wrangler dev` runs.

Tests: `npm run typecheck && npx vitest run`. They never call the real Daikin API.

---

## Design system

**Decision:** [Web Awesome](https://webawesome.com/) components themed with **Home Assistant's own design tokens**. This is the same stack Home Assistant's frontend uses: it depends on `@home-assistant/webawesome` (its fork of Web Awesome 3.14.0) and maps every `--wa-*` token onto its `--ha-*` tokens. The look is a mobile-first home-control dashboard with first-class dark mode.

### How it's put together

| Piece | Source | License |
|---|---|---|
| Components | [`@awesome.me/webawesome`](https://www.npmjs.com/package/@awesome.me/webawesome) 3.14.0 (`wa-page`, `wa-card`, `wa-radio-group`, `wa-switch`, `wa-dialog`, `wa-tab-group`…). Toasts are the app's own (`wa-toast` sets inline styles the CSP blocks), and the PayNow QR is Daikin's PNG shown as an image | MIT |
| Theme layer | [`tokens/ha-webawesome.css`](tokens/ha-webawesome.css), generated by [`tokens/build_ha_webawesome.py`](tokens/build_ha_webawesome.py) from [home-assistant/frontend `src/resources/theme`](https://github.com/home-assistant/frontend/tree/dev/src/resources/theme): HA's core, semantic and legacy colour tokens plus its `wa.globals.ts` / `color/wa.globals.ts` mapping. Scoped to `html.theme-ha`, dark mode under `html.theme-ha[data-scheme=dark]` | Apache-2.0 |
| Icons | [Material Design Icons](https://pictogrammers.com/library/mdi/) (`@mdi/svg`), registered as a Web Awesome icon library (`registerIconLibrary("mdi", …)`), as HA uses | Apache-2.0 |
| Font | Roboto (HA's `--ha-font-family-body`) | OFL |

To refresh the HA tokens, download the `*.globals.ts` files from HA's theme folder and run `python3 -I tokens/build_ha_webawesome.py <dir>`.

### Rules for the app

- **Custom pieces use only `--wa-*` tokens.** The thermostat dial, badges and tiles aren't Web Awesome components, but styling them with `--wa-*` means they follow the HA theme automatically, the same way HA's own components do.
- **Layout:** `wa-page` with `mobile-breakpoint="870"` (HA's own narrow breakpoint): drawer navigation on phones, sidebar from 871px; cards in a `wa-grid` that reflows 1 → 2 → 3 columns.
- **Dial range** comes from `/app-config` (`temperature_allowed_min`/`max`, 22–26 °C), like HA sizes its climate dial to the device's `min_temp`/`max_temp`. A dot on the track marks the room temperature.
- **Mode colours** (app overrides on top of HA's climate colours):

  | Mode | Colour | Why |
  |---|---|---|
  | Cool | `--state-climate-cool-color` (blue) | HA default |
  | Dehumidify | `--teal-color` | HA maps dry to orange, which reads as heating; teal reads as water |
  | Fan only | `--blue-grey-color` | Moves air without cooling or drying; HA's cyan clashed with teal |
  | Auto | `--state-climate-auto-color` (green) | HA default |

- **States:** pending (the ~5 s before the unit confirms) pulses the dial arc and shows a spinner, then a success toast. Offline uses the danger colour, maintenance and low balance use warning; offline and maintenance disable the controls and say why.
- **Unofficial:** no Daikin or NTU logos, and the "unofficial" note stays visible.

### Known gaps

- HA's `--ha-box-shadow-*` tokens live outside the files the build script reads, so shadows fall back to Web Awesome's defaults.

## Related

- [ntu-hall-ac-scheduler](https://github.com/ZhunHao/ntu-hall-ac-scheduler): the ESP32-C6 IR hardware version, plus `ENDPOINTS.md` with the full API notes.
