# Hall Aircon Web: Cloudflare Worker design

Date: 2026-10-30. Status: approved 2026-10-30.

## 1. Intent

NTU hall residents control their room aircon through Daikin's **NTU Hall Aircon** mobile app (`sg.daikin.ntu.ntu_mobile`). The maintainer already runs an ESP32 + IR setup ([ntu-hall-ac-scheduler](https://github.com/ZhunHao/ntu-hall-ac-scheduler)) that adds the thing the app lacks: **a nightly on/off schedule**. Most residents won't build hardware.

This project is a **web replacement for the app, plus schedules**, that any resident can run with no hardware and no technical setup:

- Each resident clicks **Deploy to Cloudflare** and gets **their own copy** on their own free Cloudflare account. Nobody else ever holds their Daikin login.
- It does what the app does (status, control, top-up, history, pairing). It also runs the resident's schedule in the cloud, even with the browser closed.
- It's polished enough to hand to non-technical residents. The UI is already designed in the mocks (see section 6).

## 2. Goals, non-goals, anti-goals

**Goals**

1. One-click deploy on the Workers Free plan. The resident's only inputs are their NTU email and a generated secret.
2. Sign in by pasting the "Cannot GET" address that NTU's sign-in ends on (see section 7.2).
3. Live status and control: power, setpoint, mode, fan, swing. Wallet balance, low-balance and offline/maintenance states.
4. **Per-night schedule** (section 8) executed server-side, including the resume after Daikin's 11:00 cut-off.
5. Top-up by PayNow QR and by card (eNETS), usage history, top-up history, notifications, FAQ-derived house rules.
6. Pair to an aircon by typing its code. Become Room Account holder behind a confirm.
7. Works on phone, tablet and desktop. Every screen is responsive, with no fixed phone frame.

**Non-goals (v1)**

- A shared, multi-user instance. One deployment = one resident = one Daikin account.
- Schedule presets or templates. Residents start empty and build their own.
- QR scanning, push or email notifications, a native or PWA install flow.
- Non-NTU (password) Daikin login.
- Auto top-up or any automatic spending.

**Anti-goals (failure even if it "works")**

- Anyone other than the owner can see or control the aircon or wallet.
- The Daikin token (JWT) or a SAML code is stored or logged in plain text.
- The schedule fights the resident. Manual changes are never undone between schedule boundaries.
- The 11:00 cut-off is hidden or blamed on the app. The UI must say the cut-off is **Daikin's hall system**.
- The app takes a payment action the resident didn't tap.

## 3. Constraints

**Cloudflare / Deploy button** (from the [deploy-buttons docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/), already summarised in the README):

- Public repo on GitHub/GitLab, with a Wrangler config file (`wrangler.jsonc`) at the root. This repo therefore uses **Wrangler**, not the `cf` CLI. The maintainer normally prefers `cf`, but the button reads Wrangler config.
- Secrets prompted from `.dev.vars.example`. Descriptions go in `package.json` → `cloudflare.bindings`.
- The button auto-provisions Durable Objects. New Durable Object namespaces **must be SQLite-backed** ([changelog 2026-07-09](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)), which the Free plan supports.
- Wrangler now offers an `exports` field as well as the older `migrations` array for declaring Durable Object classes. **Builder:** use whichever the Deploy button accepts today; confirm before relying on `exports`.

**Durable Object alarms** ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Base API](https://developers.cloudflare.com/durable-objects/api/base/), [Rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)):

- One alarm per object. It doesn't repeat; re-arm with `setAlarm()`.
- At-least-once delivery. The alarm retries with exponential backoff, starting at 2 s, up to six times, on an uncaught exception.
- It can fire more than once, so the handler **must be idempotent**.

**Daikin API** (probed 2026-10-30; details in README and `ENDPOINTS.md`):

- Base `https://apintu-prod.daikinpayu.com`. Headers `User-Agent: Dart/3.0 (dart:io)` and `Authorization: Bearer <JWT>`. Bodies are form-encoded.
- No CORS, so every call goes through the Worker.
- **402** (not 401) means the token is missing or expired.
- Rate limit `x-ratelimit-limit: 10000` per ~15 min.
- Control changes show in `GET /me` after **~4–6 s**.
- Setpoint UI range is 22–26 °C (`/app-config`). Below 22 the unit stays at 22.
- The JWT is HS256, lasts **90 days**, and its payload carries `email` (upper-case, e.g. `ABC123@e.ntu.edu.sg`) and `exp`.
- Daikin's hall system switches every aircon **off at 11:00 daily** (sessions end 11:00:03–11:00:09) and at S$0 balance.
- S$0.39/h. Wallet cap S$50, top-ups S$10–50 in S$10 steps, low-balance alert below S$3.

**Time:** all schedule times are **Singapore time** (UTC+8, no daylight saving).

## 4. Approaches

The resident picked **A** on 2026-10-30.

| | How | Trade-offs |
|---|---|---|
| **A. Worker + one Durable Object** ✅ | Worker serves the bundled UI and a JSON API. One SQLite Durable Object per deployment holds the encrypted login, owner sessions, schedule and activity log, and sets **one alarm for the next thing to do** (start, end, or 11:01 resume). | Smallest setup that does everything; free plan; nothing runs when idle. Alarm logic needs careful tests, and `runDurableObjectAlarm()` can fire alarms instantly in tests. |
| B. Worker + KV + per-minute Cron Trigger | KV stores login and schedule; a cron wakes every minute. | Uses one of only 5 free Cron Triggers per account, wakes 1,440×/day for nothing, KV edits take up to 60 s to show, 1,000 writes/day free limit. |
| C. Cloudflare Agents SDK | Framework on top of Durable Objects with scheduling and live state. | Pulls in React and the agents library for a web-components UI. The night rules and 11:01 resume are custom code anyway. |

## 5. Architecture

```text
Browser ──HTTPS──▶ Worker
                    ├─ static assets (bundled UI)
                    └─ /api/*  ── auth check ──▶ Durable Object "home" (SQLite)
                                                  ├─ encrypted Daikin JWT
                                                  ├─ owner sessions
                                                  ├─ schedule (periods, view, enabled)
                                                  ├─ activity log
                                                  └─ alarm ──▶ Daikin API
```

- **Worker:** routes `/api/*`, checks the session cookie (and the Access token when configured), then calls the Durable Object over RPC. Everything else is a static asset.
- **Durable Object:** a single instance addressed by a fixed name (e.g. `getByName("home")`). All Daikin calls go through it, so the token is decrypted in one place.
- **Config:**
  - Secret `SESSION_SECRET`: 32 random bytes, hex. Used as the key-derivation input for encrypting the JWT at rest. The README already names it; keep the name.
  - Secret `OWNER_EMAIL`: the resident's NTU email. It goes in `.dev.vars.example` so the Deploy page prompts for it.
  - Optional plain vars `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, empty by default. When both are set, the Worker verifies `Cf-Access-Jwt-Assertion` on every request (section 7.4).

## 6. UI

The UI is designed and signed off in the mocks; the build reproduces them with real data.

| Screen | Mock | Notes |
|---|---|---|
| Home: status, dial, mode/fan, tiles, top-up | `mocks/hifi.html` | Dial 22–26 °C. Pending → confirmed toasts (poll `/me` until the change shows, ~4–6 s). State variants: low balance, offline (`comm_stat` ≠ 1), maintenance. |
| Sign-in: welcome → open NTU sign-in → paste | `mocks/signin.html` | Copy and paste are one step. The paste parser `extractCode()` in the mock is the reference. Also covers the success, code-rejected and 90-days-later screens. |
| Schedule: "Show the week as" Nights/Days switch, tabs, editor with "Repeats on" day chips, week chart, copy dialog | `mocks/schedule.html` | Tabs show plain text: a range (`23:00–03:00`) for one unbroken run, otherwise "2 periods", or `Off`. Colour lives in the bars. Periods carrying over from the previous night or day show faded in the bars and as a "From Thursday: …" line that jumps there. |
| Settings: account, Sign out | `mocks/settings.html` | One Sign out button with a confirm. |
| Usage, top-ups, notifications, rest of settings (pair, Room Account, Access how-to) | not mocked | Build in the same style: `wa-page` shell, cards, HA theme. |

**Stack:**
- Web Awesome 3.14.0 components with the Home Assistant theme layer generated by `tokens/build_ha_webawesome.py`.
- MDI icons. Plain TypeScript, no framework.
- Everything is **bundled at build time**; no CDN scripts in production.

**Mode colours:**
- cool: HA cool;
- dry: **teal**;
- fan: **blue-grey**;
- auto: HA auto.

UI rules are in the README "Design system" section.

## 7. Sign-in, owner lock, sessions

### 7.1 Sign-in flow

1. The UI opens `https://cmsntu-prod.daikinpayu.com/adfs/login` in a new tab. It redirects to NTU's login.
2. After login the browser lands on `…/adfs/saml/redirect/<HASH>`, which shows "Cannot GET". Verified on 2026-10-30 in a computer browser and in an iOS browser with the official app installed: the app doesn't catch it, so every device signs in the same way.
3. The resident pastes the address (or the error text, or the bare code). The client extracts `<HASH>` with the mock's parser; the server re-validates the same way.
4. The Durable Object calls `POST /auth/ad/callback` (`hash`, `fcm_token=placeholder`) and gets the JWT.
5. The **owner check** (7.3) runs.
6. If it passes, the Durable Object encrypts and stores the JWT and creates a session (7.2).

The hash is a single-use credential. Never log it or store it.

### 7.2 Browser sessions

- On successful sign-in, the Durable Object creates a random 256-bit session token and stores only its SHA-256 hash. The session expires when the JWT does.
- The browser gets it as a cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **Sign out** is a single button with a confirm ("Your schedule stops until you sign in again."). It ends every session and deletes the stored login, so the schedule stops. The schedule's periods are kept. Most residents use one device, so there is no separate "sign out everywhere". It does **not** call Daikin's `POST /auth/logout`, because it's unknown whether that also signs the phone app out. Deleting our only copy of the token is enough.
- Each device signs in with its own paste. A newer JWT replaces the stored one. Older sessions stay valid because they point at the deployment, not at a particular JWT.
- Web-app tokens and the phone app coexist: the resident confirmed on 2026-10-30 that the phone app kept working, with alerts, after a token was issued by the paste flow.
- State-changing `/api/*` calls require `Content-Type: application/json` and a same-origin `Origin` header, on top of `SameSite=Strict`.

### 7.3 Owner lock

- After the exchange, read `email` from the JWT payload (or `GET /me`) and compare it case-insensitively with `OWNER_EMAIL`.
- On mismatch, discard the token, store nothing, and show "This copy belongs to another NTU account."
- The sign-in endpoint is the only unauthenticated API, so it is rate-limited in the Durable Object. Builder picks the numbers (e.g. 5 attempts per 10 min).

### 7.4 Cloudflare Access (optional)

- Documented in the README as an extra for residents who want it. It's a one-click setting on the `workers.dev` route.
- Zero Trust onboarding asks for a card even on Free, which is why it is optional.
- When `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, the Worker verifies the `Cf-Access-Jwt-Assertion` JWT against the team's JWKS and rejects requests without a valid one. This applies to everything, including static assets.
- The schedule alarm never passes through Access, so it is unaffected.

### 7.5 Token expiry

- Read `exp` from the JWT.
- From 7 days before expiry, show a "sign in again" banner.
- On any 402, mark the login expired and stop schedule actions (log them as skipped). Show the 90-days-later screen from the sign-in mock.
- There are no push notifications, so the banner is the only warning. Accepted for v1.

## 8. Schedule

### 8.1 Model

- **One list of periods**, each pinned to the **calendar day it starts on**: `day` (Mon–Sun), `start`, `end` (HH:MM, minute precision), `setpoint` (22–26), `mode` (C/D/F/A), `fanstep` (A/L/LM/M/MH/H).
- A period may cross midnight and may cross 11:00. It must be shorter than 24 h.
- **Two views, the resident's choice** (decided 2026-10-30). The view changes only how periods are grouped, never the schedule itself:
  - **Nights** (default): "Monday night" = Monday 12:00 → Tuesday 12:00, so 01:00 Tuesday belongs to Monday night. One night's sleep stays in one tab.
  - **Days**: Monday 00:00 → 24:00, like Nest, tado or ecobee. A 23:00 → 03:00 period sits on its start day and carries into the next.
  - A period belongs to the night or day **it starts in**. Copy and clear act on whole periods grouped that way.
  - The chosen view is saved with the schedule, so every device shows the same one. This is the designer's call.
- **No overlaps in the saved schedule**, checked across the whole week with wrap-around (Sunday night can run into Monday noon). The mock's `span()` / `overlaps()` math is the reference.
- **An overlapping save is blocked.** The dialog names the clash ("Overlaps Cool 23:00 → 01:00 on Sunday night.") and Save stays disabled until the times are changed.
- One global **enabled** switch. When paused, nothing switches automatically.
- **Repeats on** (resident request, 2026-10-30, after checking Google Home's "Repeats every" and Apple Home's day picker):
  - The add/edit dialog has Mo–Su day chips, nothing more. Saving puts the period on every ticked night or day.
  - Each night still stores its own copy, so a one-night change stays easy.
  - Editing a period ticks every night that has an identical copy (same times and settings). Saving updates those; unticking a night removes it there. Delete reads "Delete from 5 nights".
  - Each period row shows "Repeats: Every night / Weeknights / Mon, Tue, …".
  - Copies of one long period mustn't overlap each other on back-to-back nights; the dialog asks to shorten it or pick fewer nights.
- Editing tools match the mock: add, edit and delete a period; clear a night or day; "Copy Friday night to…" / "Copy Friday to…" with the view's quick picks, clash-checked before copying. A period may not be added with a start of exactly 11:00 (8.2).

### 8.2 Events

The Durable Object derives a sorted list of events for the week from the schedule:

| Event | When | Action |
|---|---|---|
| start | period start | `power=1` with the period's setpoint, mode, fan. Swing (`flap`) is left as it is. |
| end | period end | `power=0` |
| resume | 11:01 on each day a period runs across 11:00 (start < 11:00 < end, strictly) | Resume only if **Daikin** switched it off. `GET /me`: if the aircon is on, do nothing. If it's off, read the latest session in `/usage/history`. If that session ended between 11:00:00 and 11:00:59, Daikin cut it, so send the period's start command. If it ended earlier, the resident switched it off themselves; do nothing (manual changes win). |

Edge rules:

- **Back-to-back periods** (A ends exactly when B starts): send B's start only, never off-then-on.
- A period ending at exactly 11:00 gets no resume. That's how a resident opts out (UI copy in the period editor already says this).
- A period may not **start** at exactly 11:00: it would be cut off seconds later. The editor rejects it with "Daikin's hall system switches every aircon off at 11:00. Start at 11:01 or later."
- **Manual changes win.** Between events the app never re-asserts state. If the resident turns the aircon off mid-period, it stays off until the next event.

### 8.3 Alarm loop

1. After any schedule change, enable/disable, sign-in, or alarm run, compute the next event after "now" and `setAlarm()` it. With no events, or when paused, delete the alarm.
2. On alarm:
   - find the latest event whose time ≤ now that hasn't been executed;
   - execute only that one ("catch up to the state that should hold now"; don't replay a backlog after downtime);
   - record it;
   - re-arm.
3. **Idempotency:** store an execution key per event occurrence (date + event id). A repeat fire skips anything already done.
4. **Stale events:** ignore events more than 30 minutes late. Builder may tune this. Don't switch the aircon on at 04:00 for a period that started at 23:00 and was missed.
5. **Confirm:** after a control call, schedule a follow-up check about 10 s later (same alarm, earliest-time wins) that reads `GET /me`.
   - If the change didn't take, retry once.
   - If it still fails, log it as failed. No more retries until the next event.
6. **Errors:**
   - 402: login expired, so stop (see 7.5).
   - 5xx or network error: let the alarm's built-in retry handle it (throw), but not past the next event.

### 8.4 What the resident sees

- **Status card:**
  - on/off switch;
  - "Next: On 23 °C Cool at 01:00 · Sat";
  - weekly cost estimate (S$0.39/h; subtract one minute per 11:00 cut-off).
- Night tabs, night editor, week chart and copy dialog as in the mock.
- **Editing during a period:** saving never switches the aircon. If the current time falls inside an enabled period that the save created or changed, a toast offers **Apply now**, which sends the start command. This is the designer's call.
- **Activity log:** each schedule action with its time, what was sent, and the result (done / skipped / failed and why). Shown on the schedule page; keep 90 days.

## 9. API (Worker ↔ browser)

All JSON, all session-protected except sign-in. Route names are a suggestion; the builder can rename them.

| Route | Purpose |
|---|---|
| `POST /api/signin` `{ text }` | Paste text → exchange → owner check → session cookie |
| `POST /api/signout` | Sign out: end all sessions, delete the stored login (7.2) |
| `GET /api/session` | Signed in?, owner email, JWT expiry |
| `GET /api/me` | Proxied `/me` (status, wallet, aircon) |
| `POST /api/control` | Power/setpoint/mode/fan/flap |
| `GET /api/usage`, `/api/topups`, `/api/notifications` | Paged history |
| `GET /api/config` | Temperature range, top-up amounts, house rules |
| `POST /api/pair` `{ code }` | `/ac/pair`. No known endpoint previews a code's room, so the confirm repeats the typed code. After pairing, the UI shows the room name from `/me` (`aircon.room.room_name`). |
| `POST /api/room-account` (no body) | `/ac/default` for the **currently paired** aircon only. The server takes the code from `/me` (`aircon.aircon_code`), never from the client. The confirm names the room from `/me` and says the link can't be removed, only handed over. |
| `POST /api/topup` `{ amount, type }` | PayNow QR or eNETS URL |
| `GET/PUT /api/schedule` | Whole schedule (periods + enabled + view); server validates |
| `GET /api/activity` | Schedule activity log |

The server validates every input. It rejects setpoints outside 22–26, unknown modes, overlapping periods and malformed codes.

## 10. Security

- JWT encrypted at rest (AES-GCM, key derived from `SESSION_SECRET` with HKDF, fresh IV per write). Decrypted only inside the Durable Object.
- Never log JWTs, SAML hashes, session tokens or payment URLs.
- Strict CSP (self only, plus `data:` for the PayNow QR image), no inline scripts, bundled assets.
- Don't forward Daikin's `connect.sid` cookie.
- The README warns: keep the repo copy public only as the Deploy button requires. Secrets live in Cloudflare, never in the repo.

## 11. Testing

- **Pure functions** (unit tests): schedule maths.
  - overlaps with week wrap;
  - event derivation, including back-to-back periods, end exactly 11:00, and periods crossing midnight and 11:00;
  - next-event and catch-up selection;
  - cost estimate;
  - paste parser.
- **Durable Object** (`@cloudflare/vitest-plugin`, `runDurableObjectAlarm()`, eviction helpers), with Daikin mocked at the fetch layer:
  - each event type;
  - idempotent re-fire;
  - stale-event skip;
  - 402 handling;
  - confirm/retry;
  - owner-lock mismatch;
  - session expiry.
- **No test calls the real Daikin API.** A manual smoke test on the maintainer's own account comes before release.

## 12. Decided vs left to the builder

**Decided in conversation (resident):** approach A; per-deployment Deploy button; paste sign-in; owner lock by NTU email plus optional Access; Durable Object storage; noon-to-noon nights; no presets; no overlaps; periods may cross midnight and 11:00; 11:01 resume with opt-out by ending at 11:00; Daikin named as the source of the cut-off; Web Awesome + HA theme; dry = teal, fan = blue-grey; keep card top-up; responsive everywhere.

**Designer's calls (flagged for review):**
- the 11:01 resume checks usage history and skips if the resident switched off before 11:00 (8.2);
- periods can't start at exactly 11:00 (8.2);
- one Sign out that ends every session and stops the schedule (7.2);
- Room Account only for the currently paired aircon, code taken from `/me` (9);
- the Nights/Days choice is saved with the schedule, not per device (8.1);
- repeated periods are stored as per-night copies, linked only by being identical, not as one shared rule (8.1);
- saving never switches the aircon, with an optional Apply now (8.4);
- the 30-minute stale-event cutoff (8.3);
- a confirm-and-retry-once policy (8.3);
- the 90-day activity log;
- `OWNER_EMAIL` as a secret, so the Deploy page prompts for it.

**Left to the builder:**
- file layout and router (plain `fetch` routing or Hono);
- SQL schema;
- the Vite or other bundler setup for the client;
- exact rate-limit numbers;
- how the client polls `/api/me` (10 s while visible, as the app does);
- `exports` vs `migrations` in `wrangler.jsonc`.
- README fixes during the build: `SESSION_SECRET` now encrypts the stored login, not a cookie; the redirect page is verified; the Roadmap section is superseded by this design.

## 13. Answered by the resident (2026-10-30)

1. **Do web-app tokens coexist with the phone app?** Yes: the phone app kept working, alerts included, after a token was issued by the paste flow.
2. **Does sign-in work on a phone with the official app?** Yes, tested on iOS 2026-10-30: the browser shows "Cannot GET" with the code. No special phone path.
3. **Nights or days?** Let residents choose; Nights is the default (8.1).

Still unknown and designed around: whether Daikin's `POST /auth/logout` ends only one token. Sign out doesn't call it (7.2).
