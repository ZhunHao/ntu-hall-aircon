# Hall Aircon Web Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-click-deployable Cloudflare Worker that replaces the NTU Hall Aircon app in the browser and runs the resident's nightly schedule server-side.

**Architecture:**
- One Worker serves the bundled UI (static assets) and a JSON API under `/api/*`.
- One SQLite-backed Durable Object (`Home`, name `"home"`) holds:
  - the encrypted Daikin JWT,
  - sessions,
  - the schedule,
  - the activity log.
- The Durable Object makes every Daikin call and drives the schedule with a single alarm.
- Schedule maths is pure TypeScript in `src/shared/`, used by both the Durable Object and the browser.

**Tech Stack:**

| Area | Packages |
|---|---|
| Language | TypeScript 7.0.2 |
| Worker | Wrangler 4.156.0, `@cloudflare/workers-types` 5.20261030.1 |
| Tests | Vitest 5.0.5 with `@cloudflare/vitest-plugin` 1.4.11; `msw` 3.0.3 + `@msw/cloudflare` 0.2.0 for outbound mocks |
| Access check | `jose` 6.2.14 |
| Client build | Vite 8.3.5 (multi-page) |
| UI | `@awesome.me/webawesome` 3.14.0, `@mdi/js` 7.4.47, `@fontsource/roboto` 5.3.0 |

**Spec:** `docs/superpowers/specs/2026-10-30-hall-aircon-worker-design.md` (approved 2026-10-30). Executors read the spec and this plan together.

**Mocks (UI reference, already signed off):** `mocks/hifi.html` (home), `mocks/signin.html`, `mocks/schedule.html`, `mocks/settings.html`.

## Global Constraints

**Daikin API**
- Base URL `https://apintu-prod.daikinpayu.com`.
- Every call sends `User-Agent: Dart/3.0 (dart:io)` and `Authorization: Bearer <JWT>`.
- Bodies are `application/x-www-form-urlencoded`.
- Never forward Daikin's `connect.sid` cookie.
- HTTP **402** means the login expired. Treat a non-JSON 2xx body as a failure (`DaikinError`), never a crash.

**Schedule rules**
- Times are Singapore time, a fixed UTC+8 with no daylight saving. Week minute 0 = Monday 00:00 SGT; `WEEK = 10080`.
- Daikin cut-off: `CUT = 660` (11:00). The resume runs at 11:01. A period may not start at exactly 11:00. Error copy: `Daikin's hall system switches every aircon off at 11:00. Start at 11:01 or later.`
- Setpoint 22–26. Modes `C | D | F | A`. Fan steps `A | L | LM | M | MH | H`. The UI fan buttons Auto/1/2/3/4/5 map to `A/L/LM/M/MH/H`.
- Cost: S$0.39/h; subtract one minute per 11:00 cut-off.
- Stale-event cutoff: 30 min. Confirm check: 10 s after a control call, retry once. Activity log: keep 90 days.

**Sign-in and sessions**
- Paste is exchanged at `POST /auth/ad/callback` with `hash` and `fcm_token=placeholder`.
- The owner check compares the JWT `email` with `OWNER_EMAIL`, both trimmed and lower-cased.
- Mismatch copy: `This copy belongs to another NTU account.`
- Session cookie: `ha_session`, flags `HttpOnly; Secure; SameSite=Strict; Path=/`. It expires with the JWT. The Durable Object stores only the SHA-256 of the token.
- Sign out ends every session, deletes the stored JWT and clears the alarm. Schedule periods are kept. It does not call Daikin `/auth/logout`. Confirm copy: `Your schedule stops until you sign in again.`

**Security**
- Never log JWTs, SAML hashes, session tokens or payment URLs.
- JWT at rest: AES-GCM, key from HKDF-SHA-256 over `SESSION_SECRET` (hex), fresh 12-byte IV per write.
- State-changing `/api/*` requests must have `Content-Type: application/json` and an `Origin` equal to the request origin.
- CSP on HTML responses:
  ```text
  default-src 'self'; img-src 'self' data:; connect-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'
  ```
- No CDN scripts. Everything is bundled.

**Config**
- Secrets: `SESSION_SECRET` and `OWNER_EMAIL`, declared in `.dev.vars.example`.
- Optional vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, empty by default.
- Wrangler config is `wrangler.jsonc`. Declare the Durable Object with a `migrations` entry using `new_sqlite_classes: ["Home"]`. This is the path the Deploy button is documented to provision; do not use `exports`.

**UI**
- Web Awesome components, Home Assistant theme from `tokens/ha-webawesome.css` (`html.theme-ha`).
- Mode colours: cool = HA cool, dry = **teal**, fan = **blue-grey**, auto = HA auto.
- Every page works at 375 px, 768 px and 1280 px wide with no horizontal scroll.
- The 11:00 cut-off is always attributed to **Daikin's hall system**.

**Git:** the repo is not under git yet. Task 1 runs `git init`. Commit after each task.

## Review Focus

The spec implies these but no feature test would naturally hit them. Most likely to bite first:

1. **Timezone.** The Worker clock is UTC. A 23:00 start must fire at 15:00 UTC. Pinned in Task 3 (`sgtWeekMinute`, `nextEventAfter` with UTC timestamps).
2. **Sign-out with an alarm armed.** After Sign out, a pending alarm must neither send a command nor throw; it logs nothing and disarms. Pinned in Task 9.
3. **Editing the schedule while a confirm check is pending.** Re-arming after a save must keep the earlier 10 s confirm check, not replace it with the next event. Pinned in Task 9.
4. **`OWNER_EMAIL` typed with spaces or capitals at deploy time** (e.g. ` Abc123@E.ntu.edu.sg `). It still matches the JWT's upper-case email. Pinned in Task 7.
5. **Daikin returns 200 with an HTML or empty body.** The proxy returns a clean 502 JSON error, and the alarm logs `failed`, without crashing. Pinned in Task 6 and Task 9.

---

## File Structure

```text
wrangler.jsonc               Worker + DO + assets config (Deploy button reads this)
package.json                 scripts, deps, cloudflare.bindings descriptions
.dev.vars.example            SESSION_SECRET, OWNER_EMAIL (Deploy page prompts)
tsconfig.json, vitest.config.ts, vite.config.ts, .gitignore
src/shared/schedule.ts       pure: types, span/overlap, validate, grouping, cost
src/shared/events.ts         pure: week events, SGT time, next/due selection
src/shared/signin.ts         pure: extractCode() (moved from mocks/signin.html)
src/shared/api.ts            types shared by Worker and browser (Control, ApiResult, Activity, SessionInfo)
src/do/crypto.ts             HKDF/AES-GCM, sha256Hex, randomToken
src/do/store.ts              SQLite schema + typed accessors
src/do/daikin.ts             Daikin HTTP client + DaikinExpired/DaikinError
src/do/runner.ts             alarm logic (execute, confirm, resume)
src/do/home.ts               Home Durable Object: RPC surface + alarm()
src/do/fake.ts               dev-only fake Daikin (DAIKIN_FAKE=1), never on in prod
src/worker/index.ts          fetch handler: Access, routing, auth, headers, assets
src/worker/access.ts         Cloudflare Access JWT verification
src/worker/http.ts           json(), cookies, same-origin check, CSP headers
src/client/*.html            index, signin, schedule, history, settings
src/client/lib/              theme.ts, icons.ts, api.ts, shell.ts, format.ts
src/client/pages/            home.ts, signin.ts, schedule.ts, history.ts, settings.ts
test/                        *.test.ts, fixtures/daikin.ts, setup.ts
```

---

### Task 1: Project scaffold, Deploy-button config, test harness

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `.dev.vars.example`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/worker/index.ts`, `src/do/home.ts`, `test/setup.ts`, `test/fixtures/daikin.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces:
  - `Env { HOME: DurableObjectNamespace<Home>; ASSETS: Fetcher; SESSION_SECRET: string; OWNER_EMAIL: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; DAIKIN_FAKE?: string }` exported from `src/worker/index.ts`.
  - `export class Home extends DurableObject<Env>` in `src/do/home.ts`.
  - Test fixtures:
    - `test/fixtures/daikin.ts` exports `fakeJwt({ email, exp }): string` (unsigned `header.payload.sig`, base64url) and `meBody(over?: Partial<Aircon>)`.
    - `daikin` handlers built with `http` from `msw` against `https://apintu-prod.daikinpayu.com`.
    - `network` from `@msw/cloudflare`'s `setupNetwork()`.

- [ ] **Step 1: Write config files.**
  - **`wrangler.jsonc`:**
    - `name: "hall-aircon"`, `main: "src/worker/index.ts"`, `compatibility_date: "2026-10-30"`;
    - `assets: { directory: "./dist/client", binding: "ASSETS", run_worker_first: true }` (the Worker must see every request for Access checks and CSP);
    - `durable_objects.bindings: [{ name: "HOME", class_name: "Home" }]`;
    - `migrations: [{ tag: "v1", new_sqlite_classes: ["Home"] }]`;
    - `vars: { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }`;
    - `observability: { enabled: true }`.
  - **`package.json`:**
    - scripts: `build` = `vite build`, `deploy` = `wrangler deploy`, `dev` = `vite build --watch & wrangler dev`, `test` = `vitest run`, `typecheck` = `tsc --noEmit`;
    - `cloudflare.bindings` descriptions:
      - `SESSION_SECRET`: "Random key that encrypts your stored Daikin login. Generate with `openssl rand -hex 32`."
      - `OWNER_EMAIL`: "Your NTU email. Only this account can sign in to your copy."
  - **`.dev.vars.example`:** `SESSION_SECRET=generate-with-openssl-rand-hex-32` and `OWNER_EMAIL=your-id@e.ntu.edu.sg`.
  - **`.gitignore`:** `node_modules`, `dist`, `.wrangler`, `.dev.vars`.
  - **`vitest.config.ts`:**
    - `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { SESSION_SECRET: "11".repeat(32), OWNER_EMAIL: "abc123@e.ntu.edu.sg" } } })`;
    - `test.setupFiles: ["./test/setup.ts"]`, where `setup.ts` enables, resets and disables `network` as in the Cloudflare MSW guide.
- [ ] **Step 2: Write the failing smoke test** `test/smoke.test.ts`:

```ts
import { exports } from "cloudflare:workers";
it("unknown API route is a JSON 404", async () => {
  const r = await exports.default.fetch("https://x.test/api/nope");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "not-found" });
});
```

- [ ] **Step 3: Run `npx vitest run test/smoke.test.ts`.** Expected: FAIL (no worker yet).
- [ ] **Step 4: Implement minimal `src/worker/index.ts` and `src/do/home.ts`.** `/api/*` returns 404 JSON; other paths go to `env.ASSETS.fetch(request)`. `Home` is an empty class extending `DurableObject`.
- [ ] **Step 5: Run `npm install`, then `npx vitest run`.** Expected: PASS.
- [ ] **Step 6: Commit.** `git init && git add -A && git commit -m "chore: scaffold worker, DO and test harness"`

---

### Task 2: Schedule maths (pure)

**Files:**
- Create: `src/shared/schedule.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Produces (all exported from `src/shared/schedule.ts`):

```ts
export type Mode = "C" | "D" | "F" | "A";
export type Fan = "A" | "L" | "LM" | "M" | "MH" | "H";
export type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6;            // 0 = Monday
export type View = "nights" | "days";
export interface Period { day: Day; start: string; end: string; setpoint: number; mode: Mode; fan: Fan }
export interface Schedule { periods: Period[]; enabled: boolean; view: View }
export interface Span { s: number; e: number }            // week minutes, e may exceed WEEK
export type Problem = { code: "time" | "zero-length" | "start-1100" | "setpoint" | "mode" | "fan" | "overlap"; index: number; other?: number };
export const WEEK = 10080, CUT = 660, RATE_PER_HOUR = 0.39;
export function mins(hhmm: string): number;
export function dur(p: Period): number;                  // 1..1439
export function span(p: Period): Span;
export function overlaps(a: Span, b: Span): boolean;     // with ±WEEK wrap
export function cuts(x: Span): number[];                 // week minutes of 11:00 strictly inside x
export function groupOf(p: Period, view: View): Day;     // night (noon→noon) or day it starts in
export function samePeriod(a: Period, b: Period): boolean; // same start/end/setpoint/mode/fan
export function validate(s: Schedule): Problem[];
export function weeklyCost(periods: Period[]): { minutes: number; sgd: number };
```

The reference maths is in `mocks/schedule.html`: `span`, `overlaps`, `cuts`, `groupOf` and `dayFor`. Port it, don't redesign it.

- [ ] **Step 1: Write failing tests.**

```ts
const P = (day, start, end, setpoint = 24, mode = "C", fan = "A") => ({ day, start, end, setpoint, mode, fan });
it("span crosses midnight", () => expect(span(P(0, "23:00", "01:00"))).toEqual({ s: 1380, e: 1500 }));
it("Sunday night wraps into Monday", () => expect(overlaps(span(P(6, "23:00", "02:00")), span(P(0, "01:00", "03:00")))).toBe(true));
it("back-to-back is not an overlap", () => expect(overlaps(span(P(0, "23:00", "01:00")), span(P(1, "01:00", "03:00")))).toBe(false));
it("01:00 Tuesday belongs to Monday night, Tuesday day", () => {
  expect(groupOf(P(1, "01:00", "03:00"), "nights")).toBe(0);
  expect(groupOf(P(1, "01:00", "03:00"), "days")).toBe(1);
});
it("cuts lists 11:00 strictly inside", () => {
  expect(cuts(span(P(4, "01:00", "12:30")))).toEqual([4 * 1440 + 660]);
  expect(cuts(span(P(4, "01:00", "11:00")))).toEqual([]);
});
it("validate flags start at 11:00, zero length, bad setpoint, overlap", () => {
  const s = { enabled: true, view: "nights", periods: [P(0, "11:00", "12:00"), P(1, "02:00", "02:00"), P(2, "23:00", "01:00", 27), P(3, "23:00", "02:00"), P(4, "01:00", "03:00")] };
  expect(validate(s).map((p) => p.code)).toEqual(["start-1100", "zero-length", "setpoint", "overlap"]);
});
it("weekly cost subtracts a minute per cut-off", () => {
  expect(weeklyCost([P(4, "01:00", "12:30")])).toEqual({ minutes: 689, sgd: 4.48 });
});
```

  The overlap problem's `index` is the later period and `other` the earlier. `sgd` is rounded to cents.
- [ ] **Step 2: Run `npx vitest run test/schedule.test.ts`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/shared/schedule.ts`.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: schedule maths`.

---

### Task 3: Events and Singapore time (pure)

**Files:**
- Create: `src/shared/events.ts`
- Test: `test/events.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `span`, `cuts`, `WEEK`.
- Produces:

```ts
export type EventKind = "start" | "end" | "resume";
export interface SchedEvent { at: number; kind: EventKind; period: Period; id: string } // at: 0..WEEK-1, id = `${kind}@${at}`
export function weekEvents(periods: Period[]): SchedEvent[];                       // sorted by at
export function sgtWeekMinute(epochMs: number): number;                            // Monday 00:00 SGT = 0
export function nextEventAfter(periods: Period[], nowMs: number): { ev: SchedEvent; atMs: number } | null;
export function dueEvent(periods: Period[], nowMs: number, doneKeys: Set<string>, staleMs?: number):
  { ev: SchedEvent; atMs: number; key: string } | null;                            // key = `${ev.id}#${atMs}`
```

Rules from spec 8.2:
- An `end` is dropped when another period's `start` falls on the same minute.
- A `resume` sits at each cut + 1 minute.
- `dueEvent` returns only the latest occurrence ≤ now whose key isn't in `doneKeys` and that is at most `staleMs` (default 30 min) old.

- [ ] **Step 1: Write failing tests** (same `P` helper as Task 2).

```ts
const MON_0000_SGT = Date.UTC(2026, 10, 1, 16, 0);   // Mon 2 Nov 2026 00:00 SGT = Sun 1 Nov 16:00 UTC
it("SGT week minute from a UTC clock", () => {
  expect(sgtWeekMinute(MON_0000_SGT)).toBe(0);
  expect(sgtWeekMinute(MON_0000_SGT + 23 * 3600e3)).toBe(1380);
});
it("back-to-back periods give no off between them", () => {
  const ev = weekEvents([P(0, "23:00", "01:00"), P(1, "01:00", "03:00", 25, "D")]);
  expect(ev.map((e) => e.id)).toEqual(["start@1380", "start@1500", "end@1620"]);
});
it("period across 11:00 gets a resume at 11:01; ending at 11:00 does not", () => {
  expect(weekEvents([P(4, "01:00", "12:30")]).map((e) => e.id)).toEqual(["start@5820", "resume@6421", "end@6510"]);
  expect(weekEvents([P(4, "01:00", "11:00")]).some((e) => e.kind === "resume")).toBe(false);
});
it("next event: 23:00 Monday SGT fires at 15:00 UTC", () => {
  const n = nextEventAfter([P(0, "23:00", "01:00")], MON_0000_SGT + 3600e3);
  expect(new Date(n!.atMs).toISOString()).toBe("2026-11-02T15:00:00.000Z");
});
it("Sunday-night period wraps to next week's Monday end", () => {
  const n = nextEventAfter([P(6, "23:00", "01:00")], MON_0000_SGT + 6 * 1440 * 60e3 + 23.5 * 3600e3);
  expect(n!.ev.kind).toBe("end");
});
it("due: catches up to the latest event only, skips done and stale", () => {
  const ps = [P(0, "23:00", "01:00"), P(1, "01:00", "03:00", 25, "D")];
  const at0105 = MON_0000_SGT + (1440 + 65) * 60e3;
  expect(dueEvent(ps, at0105, new Set())!.ev.id).toBe("start@1500");
  const d = dueEvent(ps, at0105, new Set())!;
  expect(dueEvent(ps, at0105, new Set([d.key]))).toBeNull();
  expect(dueEvent(ps, MON_0000_SGT + (1440 + 120) * 60e3, new Set())).toBeNull();   // 01:00 start is 60 min stale
});
```

- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `src/shared/events.ts`.**
  - SGT minute: `new Date(ms + 8 * 3600e3)`, then `(getUTCDay() + 6) % 7`, `getUTCHours()` and `getUTCMinutes()`.
  - Occurrence epoch: the start of this SGT week, plus `at`, minus 7 days if that lands in the future, as needed.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: schedule events in Singapore time`.

---

### Task 4: Paste parser (pure)

**Files:**
- Create: `src/shared/signin.ts`
- Test: `test/signin-parse.test.ts`

**Interfaces:**
- Produces: `export function extractCode(text: string): { code: string } | { error: string }`. The empty string returns `{ error: "" }`.

Port `extractCode` from `mocks/signin.html` verbatim, including its error copy.

- [ ] **Step 1: Write failing tests.**

```ts
it("full URL", () => expect(extractCode("https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/AbCdEf0123456789/xYz+Q==")).toEqual({ code: "AbCdEf0123456789/xYz+Q==" }));
it("Cannot GET text", () => expect(extractCode("Cannot GET /adfs/saml/redirect/AbCdEf0123456789/xYz+Q==")).toEqual({ code: "AbCdEf0123456789/xYz+Q==" }));
it("URL-encoded", () => expect(extractCode("https://cmsntu-prod.daikinpayu.com/adfs/saml/redirect/AbCdEf0123456789%2FxYz%2BQ%3D%3D")).toEqual({ code: "AbCdEf0123456789/xYz+Q==" }));
it("cut off", () => expect(extractCode(".../adfs/saml/redirect/Ab12")).toEqual({ error: "The code looks cut off. Copy the whole address again." }));
it("login page instead", () => expect("error" in extractCode("https://loginfs.ntu.edu.sg/adfs/ls/")).toBe(true));
```

- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: sign-in paste parser`.

---

### Task 5: Crypto and Durable Object storage

**Files:**
- Create: `src/do/crypto.ts`, `src/do/store.ts`, `src/shared/api.ts` (starts with `Activity`)
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:

```ts
// crypto.ts
export async function encrypt(secretHex: string, plain: string): Promise<string>;   // base64(iv|ciphertext)
export async function decrypt(secretHex: string, blob: string): Promise<string>;
export async function sha256Hex(s: string): Promise<string>;
export function randomToken(): string;                                            // 32 random bytes, base64url
// store.ts  (constructed in Home's constructor inside blockConcurrencyWhile)
export class Store {
  constructor(sql: SqlStorage);
  get<T>(key: string): T | undefined; put(key: string, v: unknown): void; del(key: string): void;   // kv table, JSON values
  addSession(hash: string, expiresMs: number): void; hasSession(hash: string, nowMs: number): boolean; clearSessions(): void;
  log(a: Omit<Activity, "id">): void; activity(limit: number): Activity[]; prune(nowMs: number): void;   // drop > 90 days
  attempt(nowMs: number, windowMs: number): number;                               // records one attempt, returns count in window
}
// src/shared/api.ts
export interface Activity { id: number; at: number; kind: "start" | "end" | "resume" | "apply"; summary: string; result: "done" | "skipped" | "failed"; reason?: string }
```

- **Tables:** `kv(key TEXT PRIMARY KEY, value TEXT)`, `sessions(hash TEXT PRIMARY KEY, expires INTEGER)`, `activity(id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, summary TEXT, result TEXT, reason TEXT)`, `attempts(at INTEGER)`.
- **kv keys used later:** `jwt` (encrypted), `jwtExp` (ms), `email`, `expired` (bool), `schedule` (Schedule), `done` (string[] of the last 50 keys), `pending` (Pending, Task 9).

- [ ] **Step 1: Write failing tests** using `runInDurableObject(env.HOME.getByName("t"), (_, state) => new Store(state.storage.sql))`.
  - encrypt/decrypt round-trip, and the ciphertext differs on each call;
  - `decrypt` with a different secret rejects;
  - an expired session is not valid;
  - `clearSessions` empties the table;
  - `prune` drops an activity row 91 days old and keeps one 89 days old;
  - `attempt` counts 3 inside a 10-minute window and 1 after the window passes.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Key: `crypto.subtle.importKey("raw", hex→bytes, "HKDF")`, then `deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("hall-aircon jwt v1") }, …, { name: "AES-GCM", length: 256 })`.
  - Create the tables with `CREATE TABLE IF NOT EXISTS`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: encrypted store for the Home DO`.

---

### Task 6: Daikin client

**Files:**
- Create: `src/do/daikin.ts`, `src/do/fake.ts`
- Test: `test/daikin.test.ts`

**Interfaces:**
- Produces:

```ts
export class DaikinExpired extends Error {}
export class DaikinError extends Error { constructor(public status: number, msg: string) }
export interface Aircon { power: 0 | 1; setpoint: number; mode: Mode; fanstep: Fan; flap: "N" | "S"; comm_stat: number; maintenance_mode: number; aircon_code: string; current_temperature: number; room: { room_name: string } }
export interface Me { email: string; firstname: string; balance: number; aircon: Aircon | null }
export interface Control { power?: 0 | 1; setpoint?: number; mode?: Mode; fanstep?: Fan; flap?: "N" | "S" }   // partial body is fine (ENDPOINTS 2.2)
export interface UsageRow { starttime: string; endtime: string | null; duration: number; amount: number }
export class Daikin {
  constructor(jwt: string | null, fetcher?: typeof fetch);     // fetcher defaults to global fetch; fake.ts supplies one in dev
  exchange(hash: string): Promise<string>;                     // POST /auth/ad/callback → JWT
  me(): Promise<Me>; control(c: Control): Promise<void>;
  usage(limit: number, offset: number): Promise<{ rows: UsageRow[]; total: number }>;
  topups(limit: number, offset: number): Promise<unknown>; notifications(limit: number, offset: number): Promise<unknown>;
  config(key: string): Promise<unknown>; faq(): Promise<unknown>;
  pair(code: string): Promise<void>; makeDefault(code: string): Promise<void>;
  topup(amount: number, type: "PayNow" | "VisaMaster"): Promise<{ qrcode?: string; payment_url?: string }>;
}
export function jwtClaims(jwt: string): { email: string; exp: number };   // decode payload only (cannot verify Daikin's HS256 key)
export function fakeFetch(): typeof fetch;                    // src/do/fake.ts: answers /me, /v2/ac/control, /usage/history, … from in-memory state
```

All responses unwrap `{ data }`.

- [ ] **Step 1: Write failing tests with `network.use(...)`.**
  - `me()` sends the Dart UA and Bearer header and returns `data`;
  - `control({ power: 1, setpoint: 23 })` posts a form body `power=1&setpoint=23`;
  - a 402 throws `DaikinExpired`;
  - a 500 throws `DaikinError` with status 500;
  - **Review Focus 5:** a 200 whose body is `<html>` throws `DaikinError`;
  - `jwtClaims(fakeJwt({ email: "ABC123@e.ntu.edu.sg", exp: 1800000000 }))` returns the email and exp.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `daikin.ts`.** Implement `fake.ts` with an in-memory aircon so local UI work needs no account. It applies control changes after 4 s, to mimic the delay.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Daikin client`.

---

### Task 7: Sign-in, owner lock, sessions, sign-out (DO)

**Files:**
- Modify: `src/do/home.ts`, `src/shared/api.ts` (add `SessionInfo`)
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces (RPC methods on `Home`):

```ts
signIn(text: string): Promise<{ ok: true; token: string; expiresMs: number } | { ok: false; error: "rate-limited" | "no-code" | "rejected" | "not-owner" }>;
session(tokenHash: string): Promise<SessionInfo>;    // SessionInfo = { valid: boolean; email?: string; expiresMs?: number; expired?: boolean }
signOut(): Promise<void>;
protected daikin(): Promise<Daikin>;                 // decrypts jwt; throws DaikinExpired if none or expired
// src/do/home.ts, exported for tests:
export function isOwner(ownerEmail: string, jwtEmail: string): boolean;   // trim + lower-case both
```

Behaviour:
- Rate limit: 5 attempts per 10 minutes, counted before the exchange.
- An exchange that fails (Daikin 4xx) returns `rejected`.
- The owner check uses `jwtClaims`.
- On success:
  - store the encrypted JWT, `jwtExp = exp * 1000` and `email`;
  - clear `expired`;
  - add a session that expires at `jwtExp`;
  - re-arm the schedule (Task 9 hook; a no-op until then).
- `signOut` clears sessions, deletes `jwt`/`jwtExp` and `deleteAlarm()`s.

- [ ] **Step 1: Write failing tests** with MSW mocking `/auth/ad/callback`.
  - A good paste returns a token; `session(sha256(token))` is valid with the email.
  - The JWT email `OTHER@e.ntu.edu.sg` returns `not-owner`, and nothing is stored (`kv.jwt` undefined).
  - **Review Focus 4:** `isOwner(" Abc123@E.ntu.edu.sg ", "ABC123@e.ntu.edu.sg")` is true; `isOwner("abc123@e.ntu.edu.sg", "abc1234@e.ntu.edu.sg")` is false.
  - The 6th attempt within 10 minutes returns `rate-limited`.
  - `signOut` invalidates every session and no alarm remains (`getAlarm()` is null).
  - A session past `jwtExp` is invalid.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: sign-in with owner lock and sessions`.

---

### Task 8: Proxy RPC (status, control, history, pairing, top-up)

**Files:**
- Modify: `src/do/home.ts`, `src/shared/api.ts`
- Test: `test/proxy.test.ts`

**Interfaces:**
- Produces: `type ApiResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 401 | 502; error: string }` in `src/shared/api.ts`.
- `Home` methods each return an `ApiResult`:
  - `me()`, `control(c: Control)`;
  - `usage(limit, offset)`, `topups(limit, offset)`, `notifications(limit, offset)`, `config()`;
  - `pair(code)`, `roomAccount()`, `topup(amount, type)`.
- `config()` returns `{ tempMin, tempMax, amounts: number[], faq }` from `/app-config` keys and `/faq`.

Rules:
- **Validation errors (400):** setpoint outside 22–26, unknown mode or fan, code not matching `/^H\d+-\d{2}-\d{2}-\d{4}-\d{2}$/`, amount not in {10, 20, 30, 40, 50}, type not PayNow|VisaMaster.
- **Daikin errors:** `DaikinExpired` → 401 `expired`, and set kv `expired = true`. `DaikinError` → 502 `daikin`.
- **`roomAccount()`:** reads `/me` and calls `makeDefault(me.aircon.aircon_code)`. It never takes a code from the client, and returns 400 `not-paired` when `aircon` is null.

- [ ] **Step 1: Write failing tests.**
  - `control({ setpoint: 27 })` returns 400 and makes no outbound call (MSW `onUnhandledRequest: "error"` catches stray calls);
  - `me()` with 402 upstream returns 401, and `session()` now reports `expired: true`;
  - `roomAccount()` posts `code=H11-12-34-5678-01` taken from the mocked `/me`;
  - `topup(15, "PayNow")` returns 400;
  - **Review Focus 5:** `/me` returning 200 with an empty body gives `{ ok: false, status: 502 }`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Daikin proxy RPC with validation`.

---

### Task 9: Schedule storage, alarm loop, resume and confirm

**Files:**
- Create: `src/do/runner.ts`
- Modify: `src/do/home.ts`
- Test: `test/alarm.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6.
- Produces (on `Home`):

```ts
getSchedule(): Promise<Schedule>;                    // default { periods: [], enabled: true, view: "nights" }
putSchedule(s: Schedule): Promise<{ ok: true } | { ok: false; problems: Problem[] }>;
applyNow(): Promise<ApiResult<{ applied: boolean }>>;  // sends start for the period covering now, if any
activity(limit: number): Promise<Activity[]>;
alarm(): Promise<void>;
```

```ts
// runner.ts
export interface Pending { checkAtMs: number; key: string; expect: Control; retried: boolean }
export interface RunCtx { store: Store; daikin: () => Promise<Daikin>; now: number }
export async function runDue(ctx: RunCtx): Promise<void>;
export async function runConfirm(ctx: RunCtx, p: Pending): Promise<void>;
export function nextWake(store: Store, now: number): number | null;   // min(pending.checkAtMs, nextEventAfter) or null when paused/signed out
```

Behaviour:
- **Arming:** `putSchedule` validates with `validate()` and stores. `arm()` = `nextWake` → `setAlarm` or `deleteAlarm`. It runs after `putSchedule`, sign-in, sign-out and every `alarm()`.
- **`alarm()` order:**
  1. If signed out (no `jwt`) or `expired`, do nothing and disarm.
  2. If `pending` is due, run the confirm check.
  3. `runDue`.
  4. `prune`, then arm.
- **Event actions:**

  | Event | Action |
  |---|---|
  | start | `control({ power: 1, setpoint, mode, fanstep })` |
  | end | `control({ power: 0 })` |
  | resume | `me()`. If on, log skipped "already on". If off, `usage(1, 0)`: if the latest `endtime` (SGT) is between 11:00:00 and 11:00:59 today, send the start command; otherwise log skipped "switched off before 11:00". |

- **After each control call:** set `pending = { checkAtMs: now + 10_000, key, expect, retried: false }`. On confirm:
  - if `/me` matches `expect`, log done;
  - else if not yet retried, resend and set `retried: true`;
  - else log failed "the aircon didn't respond".
- **Bookkeeping:** record `key` in `done` before acting, so a re-fire is idempotent.
- **Errors:** `DaikinExpired` sets `expired`, logs skipped "signed out by Daikin", disarms and does not throw. `DaikinError` logs failed and does not throw; the next event still runs.
- **Summary copy:**
  - `On 23 °C Cool, fan auto`
  - `Off`
  - `Back on after Daikin's 11:00 cut-off`

- [ ] **Step 1: Write failing tests.** Use `runInDurableObject` to set the clock-free inputs. Pass `now` through `runDue` (export it) and call `runDurableObjectAlarm` for the integration cases.
  - A start event sends the right form body and logs done after a matching confirm.
  - A second alarm for the same occurrence sends nothing (idempotent).
  - An event 31 minutes late is skipped silently, with no control call.
  - Resume with usage `endtime` `…T11:00:05.000+08:00` sends start; with `…T10:30:00.000+08:00` it sends nothing and logs skipped.
  - A confirm mismatch resends once, then logs failed.
  - A 402 during start sets `expired` and leaves no alarm.
  - **Review Focus 2:** after `signOut()`, `runDurableObjectAlarm` sends nothing and leaves no alarm.
  - **Review Focus 3:** with a pending confirm at now+10 s and a next event in an hour, `putSchedule` leaves `getAlarm()` at now+10 s.
  - **Review Focus 5:** a start whose control returns 200 with an HTML body logs failed and keeps the next event armed.
  - `putSchedule` with an overlap returns its problems and stores nothing.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `runner.ts` and the `Home` methods.**
- [ ] **Step 4: Run `npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat: schedule alarm loop with resume and confirm`.

---

### Task 10: Worker router, auth, Access, headers

**Files:**
- Modify: `src/worker/index.ts`
- Create: `src/worker/http.ts`, `src/worker/access.ts`
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: the `Home` RPC from Tasks 7–9.
- Produces: the HTTP API from spec section 9. Map `ApiResult` to status. `401 { error: "signed-out" }` when there's no valid session.

Routes:

| Route | Calls |
|---|---|
| `POST /api/signin {text}` | `signIn`; sets cookie `ha_session` with `Max-Age` up to `expiresMs` |
| `POST /api/signout` | `signOut`; clears the cookie |
| `GET /api/session` | session info |
| `GET /api/me` | |
| `POST /api/control` | |
| `GET /api/usage?limit&offset` | |
| `GET /api/topups` | |
| `GET /api/notifications` | |
| `GET /api/config` | |
| `POST /api/pair {code}` | |
| `POST /api/room-account` | |
| `POST /api/topup {amount,type}` | |
| `GET`, `PUT /api/schedule` | |
| `POST /api/schedule/apply-now` | |
| `GET /api/activity` | |

Rules:
- **Unauthenticated:** only `signin` and `session` work without a session.
- **CSRF:** non-GET requests without `Content-Type: application/json` or with a foreign `Origin` → `403 { error: "bad-origin" }`.
- **`access.ts`:** `verifyAccess(req, env): Promise<boolean>`. It returns true when either var is empty. Otherwise it verifies `Cf-Access-Jwt-Assertion` with `jose.jwtVerify` against `createRemoteJWKSet(new URL(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))`, with audience `ACCESS_AUD` and issuer `https://${ACCESS_TEAM_DOMAIN}`. On failure the response is `403`.
- **Headers:** `.html` asset responses get the CSP from Global Constraints, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Logging:** never log request bodies.

- [ ] **Step 1: Write failing tests** through `exports.default.fetch`.
  - `/api/me` without a cookie → 401.
  - Sign-in sets an `HttpOnly; Secure; SameSite=Strict` cookie, and `/api/me` with it → 200 (MSW `/me`).
  - `POST /api/control` with `Origin: https://evil.test` → 403.
  - `PUT /api/schedule` with an overlap → 400 with `problems`.
  - With `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` set and no assertion header → 403 (MSW serves an empty JWKS).
  - The `Set-Cookie` on sign-out has `Max-Age=0`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat: worker API, sessions, Access and headers`.

---

### Task 11: Client foundation (build, theme, icons, shell, API wrapper)

**Files:**
- Create: `vite.config.ts`, `src/client/lib/theme.ts`, `src/client/lib/icons.ts`, `src/client/lib/api.ts`, `src/client/lib/shell.ts`, `src/client/lib/format.ts`
- Test: `test/client-format.test.ts`

**Interfaces:**
- Produces:

```ts
// api.ts — fetch wrapper; on 401 "signed-out" redirects to /signin.html; on "expired" to /signin.html#expired
export async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T>;
// shell.ts — wraps page content in wa-page (mobile-breakpoint="870") with nav Home · Schedule · History · Settings,
// the 7-days-before-expiry banner ("Sign in again by <date>"), and the light/dark toggle
export function mountShell(active: "home" | "schedule" | "history" | "settings"): HTMLElement;   // returns the content slot
// icons.ts — registerIconLibrary("mdi", resolver → data:image/svg+xml from @mdi/js paths); ICONS map copied from the mocks
// format.ts
export function sgd(n: number): string;                          // "S$12.40"
export function fanLabel(f: Fan): string; export function fanFromUi(n: "A" | "1" | "2" | "3" | "4" | "5"): Fan;
```

Build and theme:
- **`vite.config.ts`:**
  - `root: "src/client"`, `build.outDir: "../../dist/client"`, `emptyOutDir: true`;
  - `rollupOptions.input`: the five HTML pages;
  - `server.proxy["/api"]` → the `wrangler dev` port.
- **`theme.ts`:** imports `@awesome.me/webawesome/dist/styles/webawesome.css`, `../../../tokens/ha-webawesome.css` and `@fontsource/roboto` (400/500/700). It sets `html.theme-ha` and the mode colour variables from the README's Design system table.
- **Components:** import only what's used, from `@awesome.me/webawesome/dist/components/<name>/<name>.js`.

Steps:
- [ ] **Step 1: Write failing tests.** `fanFromUi("3") === "M"`, `fanLabel("LM") === "2"`, `sgd(12.4) === "S$12.40"`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the build and check it.** Run `npx vitest run test/client-format.test.ts` then `npm run build`. Expected: PASS, and `dist/client/index.html` exists. `grep -r "cdn.jsdelivr\|googleapis" dist/client` prints nothing.
- [ ] **Step 5: Commit** `feat: client build, theme, icons and shell`.

---

### Task 12: Sign-in page

**Files:**
- Create: `src/client/signin.html`, `src/client/pages/signin.ts`

**Interfaces:**
- Consumes: `extractCode` (Task 4), `api` (Task 11), `POST /api/signin`, `GET /api/session`.

Reproduce `mocks/signin.html` screens without the mock preview bar:
- welcome;
- step 1, open NTU sign-in at `https://cmsntu-prod.daikinpayu.com/adfs/login` in a new tab;
- step 2, copy and paste;
- busy;
- success;
- rejected;
- expired, shown when the URL hash is `#expired`.

Server errors map to screens and copy:

| Error | Shows |
|---|---|
| `rejected` | the rejected screen |
| `not-owner` | the copy `This copy belongs to another NTU account.` |
| `rate-limited` | `Too many tries. Wait 10 minutes and try again.` |

Success shows the name, aircon code and wallet from `/api/me`, plus "Sign in again by" from the session, then links to `/`. If `/api/session` is already valid on load, go to `/`.

- [ ] **Step 1: Build and run locally.** Run `npm run build`, with `.dev.vars` holding `DAIKIN_FAKE=1` and test secrets, then `npx wrangler dev`.
- [ ] **Step 2: Verify in a browser at 375, 768 and 1280 px.**
  - A pasted `Cannot GET /adfs/saml/redirect/AbCdEf0123456789/xYz+Q==` enables Finish. The fake signs in and the success screen shows.
  - A cut-off code shows the cut-off error.
  - No console errors and no horizontal scroll.
- [ ] **Step 3: Commit** `feat: sign-in page`.

---

### Task 13: Home page (status, control, top-up)

**Files:**
- Create: `src/client/index.html`, `src/client/pages/home.ts`

**Interfaces:**
- Consumes: `GET /api/me`, `POST /api/control`, `GET /api/config`, `POST /api/topup`, `GET /api/schedule`, plus `nextEventAfter` and `weeklyCost` from `src/shared/`.

Reproduce `mocks/hifi.html` with real data:
- **Polling:** poll `/api/me` every 10 s while `document.visibilityState === "visible"`.
- **Dial:** spans `tempMin..tempMax` from config (22–26).
- **Controls:** mode buttons (Cool, Dehumidify, Fan, Auto), fan Auto/1–5, swing toggle, power.
- **Pending → confirmed:** after each control, show pending and poll `/api/me` every 2 s for up to 15 s. Then toast "Done", or "The aircon didn't respond. Try again." on timeout.
- **Tiles:** balance with a low-balance state below S$3, room temperature, schedule "Next: …", and Daikin auto-off at 11:00.
- **States:** offline (`comm_stat !== 1`), maintenance, not paired (link to Settings).
- **Top-up dialog:** amounts from config.
  - PayNow shows the QR as an `<img src="data:…">` with a 15-minute countdown.
  - Card shows the "Untick Save Card" callout from the mock, then opens `payment_url` in a new tab only after the resident taps Continue to eNETS.

- [ ] **Step 1: Run against the fake** (`DAIKIN_FAKE=1`, `wrangler dev`).
- [ ] **Step 2: Verify at 375, 768 and 1280 px.**
  - Dragging the dial to 23 shows pending, then the fake confirms after ~4 s.
  - Power off/on works.
  - The PayNow QR renders under the CSP.
  - Card does not open eNETS until Continue is tapped.
  - No console errors.
- [ ] **Step 3: Commit** `feat: home page`.

---

### Task 14: Schedule page

**Files:**
- Create: `src/client/schedule.html`, `src/client/pages/schedule.ts`

**Interfaces:**
- Consumes:
  - `GET`/`PUT /api/schedule`, `POST /api/schedule/apply-now`, `GET /api/activity`;
  - `src/shared/schedule.ts` (`validate`, `groupOf`, `samePeriod`, `weeklyCost`, `cuts`, `span`);
  - `nextEventAfter`.

Port `mocks/schedule.html`, replacing the mock's local maths with the shared module and its sample data with the API:
- the status card with the enabled switch and "Next: …";
- the cost stat;
- "Show the week as" with Nights/Days, saved in `schedule.view`, and its toast;
- night/day tabs with the plain-text summary;
- the selected-window card with bar, carry-over line and period rows with "Repeats: …";
- the week chart;
- the add/edit dialog with "Repeats on" chips and blocking messages (overlap, 11:00 start, too long to repeat);
- the copy dialog with quick picks;
- clear;
- the info callout.

Additions over the mock:
- **Saving:** every change `PUT`s the whole schedule. On 400, show the first problem in the dialog's message area.
- **Apply now:** if the save created or changed a period covering now, a toast offers **Apply now**, which calls `apply-now`.
- **Activity:** an "Activity" card lists `/api/activity` (time, summary, done/skipped/failed with reason).

- [ ] **Step 1: Run against the fake.**
- [ ] **Step 2: Verify at 375, 768 and 1280 px.**
  - Adding 23:00→01:00 on Mo–Th persists across reload.
  - An overlapping add is blocked with the overlap message.
  - Starting at 11:00 is blocked with the Daikin message.
  - Switching to Days keeps the cost unchanged.
  - Pausing shows "Nothing will switch automatically…".
  - No console errors.
- [ ] **Step 3: Commit** `feat: schedule page`.

---

### Task 15: History and Settings pages

**Files:**
- Create: `src/client/history.html`, `src/client/pages/history.ts`, `src/client/settings.html`, `src/client/pages/settings.ts`

**Interfaces:**
- Consumes: `GET /api/usage`, `/api/topups`, `/api/notifications`, `GET /api/me`, `POST /api/pair`, `POST /api/room-account`, `POST /api/signout`, `GET /api/session`.

History:
- Three `wa-tab`s: Usage (start, end, minutes, S$), Top-ups (date, type, amount, status), Notifications.
- 20 rows per page with "Load more".

Settings follows `mocks/settings.html`:
- **Account card:** name, "Sign in again by".
- **Pair:**
  - a code input validated with the Task 8 pattern;
  - the confirm repeats the typed code;
  - afterwards it shows `aircon.room.room_name`.
- **Room Account:**
  - only shown when paired;
  - the confirm names the room;
  - copy: `This makes you the Room Account holder for <room>: the physical remote will bill your wallet. It can't be removed, only handed to someone else.`
- **Sign out:** one button; confirm `Your schedule stops until you sign in again.`; then `/signin.html`.
- **"Extra protection (optional)":** a `wa-details` explaining Cloudflare Access in 3 steps, taken from the README.

- [ ] **Step 1: Run against the fake.**
- [ ] **Step 2: Verify at 375, 768 and 1280 px.** Sign out leads to the sign-in page, and `/api/me` then returns 401. Pairing a bad code shows the validation message. No console errors.
- [ ] **Step 3: Commit** `feat: history and settings pages`.

---

### Task 16: README, deploy check, manual smoke test

**Files:**
- Modify: `README.md`, `wireframe.html` (link the mocks as design references only)

Steps:
- [ ] **Step 1: Update the README.**
  - `SESSION_SECRET` encrypts the stored login, not a cookie.
  - Add `OWNER_EMAIL` to the Deploy steps.
  - The redirect page is verified on desktop and iOS.
  - Replace the "Roadmap" section with a short "Schedules" section pointing to the spec.
  - Add the Cloudflare Access steps.
- [ ] **Step 2: Run `npm run typecheck && npx vitest run && npm run build && npx wrangler deploy --dry-run`.** Expected: all succeed. The dry run lists the `HOME` Durable Object and the assets.
- [ ] **Step 3: Manual smoke test on the maintainer's account (no fake), with the maintainer present.**
  - deploy to their account;
  - sign in by paste;
  - change the setpoint;
  - add a period starting 3 minutes from now and ending 6 minutes from now;
  - confirm the activity log shows start done and end done;
  - sign out.
  
  Do not exchange any code the maintainer pasted earlier in chat.
- [ ] **Step 4: Commit** `docs: README for deploy and schedules`.
