import { formatTime, parseTime, shortestStep, typeDigit, wrap } from "./time-wheel-logic";

// A looping hour:minute wheel, like the iPhone's. Scroll or swipe a column, click a row, use the arrow keys, or click
// a column and type (see typeDigit). Rows are plain elements styled by classes in styles/schedule.css; nothing sets
// inline styles, which the CSP (style-src 'self') would block.

/** Row height in px; must match `.tw-col > div` in schedule.css. */
const ROW = 40;
/** The values repeat this many times so scrolling feels endless; the wheel quietly re-centres on the middle copy. */
const COPIES = 7;
const MID = 3;
/** Blank rows above and below, so the column is five rows tall with the value in the middle. */
const PAD = 2;
/** How long scrolling must pause before the wheel reads its value. */
const SETTLE_MS = 120;

function behavior(): ScrollBehavior {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

class Column {
  readonly el = document.createElement("div");
  value = 0;
  /** The row centred (or being scrolled to), counted from the first value row. */
  private row = 0;
  private buffer = "";
  private rows: HTMLElement[] = [];
  private marked: HTMLElement[] = [];
  private timer = 0;

  constructor(
    private readonly n: number,
    label: string,
    private readonly onChange: () => void,
    private readonly onAdvance: () => void,
  ) {
    const el = this.el;
    el.className = "tw-col";
    el.tabIndex = 0;
    el.setAttribute("role", "spinbutton");
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", String(n - 1));
    const pad = () => {
      const p = document.createElement("div");
      p.className = "tw-pad";
      return p;
    };
    for (let i = 0; i < PAD; i++) el.append(pad());
    for (let r = 0; r < COPIES * n; r++) {
      const d = document.createElement("div");
      d.textContent = String(r % n).padStart(2, "0");
      d.dataset.r = String(r);
      this.rows.push(d);
      el.append(d);
    }
    for (let i = 0; i < PAD; i++) el.append(pad());
    this.row = MID * n;
    this.aria();

    el.addEventListener("scroll", () => {
      this.paint();
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.settle(), SETTLE_MS);
    });
    el.addEventListener("click", (e) => {
      el.focus();
      const r = (e.target as HTMLElement).dataset.r;
      if (r !== undefined) this.commit(Number(r) % n);
    });
    el.addEventListener("focus", () => (this.buffer = ""));
    el.addEventListener("blur", () => (this.buffer = ""));
    el.addEventListener("keydown", (e) => this.key(e));
  }

  /** Shows `v` straight away (no animation, no events). Used when the dialog fills the form. */
  set(v: number): void {
    this.value = wrap(v, this.n);
    this.row = MID * this.n + this.value;
    this.aria();
    this.sync();
  }

  /** Moves the scroll position to `row`. Does nothing while the column is hidden; `sync` runs again when shown. */
  sync(): void {
    if (!this.el.clientHeight) return;
    this.el.scrollTop = this.row * ROW;
    this.paint();
  }

  /** A change the user made: scroll there the short way round and tell the page. */
  private commit(v: number): void {
    v = wrap(v, this.n);
    this.row += shortestStep(this.value, v, this.n);
    const changed = v !== this.value;
    this.value = v;
    this.aria();
    this.el.scrollTo({ top: this.row * ROW, behavior: behavior() });
    if (changed) this.onChange();
  }

  private key(e: KeyboardEvent): void {
    const k = e.key;
    if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      this.buffer = "";
      this.commit(this.value + (k === "ArrowUp" ? -1 : 1));
    } else if (k === "Home" || k === "End") {
      e.preventDefault();
      this.buffer = "";
      this.commit(k === "Home" ? 0 : this.n - 1);
    } else if (k === ":" || k === ".") {
      e.preventDefault();
      this.buffer = "";
      this.onAdvance();
    } else if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      const r = typeDigit(this.buffer, k, this.n - 1);
      this.buffer = r.buffer;
      this.commit(r.value);
      if (r.advance) this.onAdvance();
    }
  }

  /** After scrolling stops: read the centred value and move back to the middle copy if it drifted far. */
  private settle(): void {
    if (!this.el.clientHeight) return;
    const row = Math.round(this.el.scrollTop / ROW);
    const v = wrap(row, this.n);
    this.row = MID * this.n + v;
    if (Math.abs(row - this.row) > this.n / 2) {
      this.el.classList.add("tw-jump");
      this.el.scrollTop = this.row * ROW;
      this.el.classList.remove("tw-jump");
      this.paint();
    } else {
      this.row = row;
    }
    if (v !== this.value) {
      this.value = v;
      this.aria();
      this.onChange();
    }
  }

  /** Fades rows by distance from the middle band. */
  private paint(): void {
    for (const m of this.marked) delete m.dataset.d;
    const i = Math.round(this.el.scrollTop / ROW);
    this.marked = [];
    for (const j of [i - 1, i, i + 1]) {
      const row = this.rows[j];
      if (!row) continue;
      row.dataset.d = String(Math.abs(j - i));
      this.marked.push(row);
    }
  }

  private aria(): void {
    this.el.setAttribute("aria-valuenow", String(this.value));
    this.el.setAttribute("aria-valuetext", String(this.value).padStart(2, "0"));
  }
}

/** `<time-wheel label="On at">` with a `value` of "HH:MM"; fires `input` and `change` when the user changes it. */
export class TimeWheel extends HTMLElement {
  private hour?: Column;
  private minute?: Column;
  private pending: [number, number] = [0, 0];

  connectedCallback(): void {
    if (this.hour) return;
    const label = this.getAttribute("label") ?? "";
    const id = `tw-${Math.random().toString(36).slice(2, 8)}`;
    const title = document.createElement("span");
    title.className = "flabel";
    title.id = id;
    title.textContent = label;

    const changed = () => {
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const minute = new Column(60, `${label}, minute`, changed, () => {});
    const hour = new Column(24, `${label}, hour`, changed, () => minute.el.focus());
    this.hour = hour;
    this.minute = minute;

    const wheel = document.createElement("div");
    wheel.className = "tw";
    wheel.setAttribute("role", "group");
    wheel.setAttribute("aria-labelledby", id);
    const band = document.createElement("div");
    band.className = "tw-band";
    const sep = document.createElement("span");
    sep.className = "tw-sep";
    sep.textContent = ":";
    wheel.append(band, hour.el, sep, minute.el);
    this.append(title, wheel);
    this.value = formatTime(...this.pending);

    // The dialog is hidden when the form is filled, and a hidden column can't scroll; line it up once it shows.
    let shown = false;
    new ResizeObserver(() => {
      const now = wheel.clientHeight > 0;
      if (now && !shown) {
        hour.sync();
        minute.sync();
      }
      shown = now;
    }).observe(wheel);
  }

  get value(): string {
    return this.hour && this.minute ? formatTime(this.hour.value, this.minute.value) : formatTime(...this.pending);
  }

  set value(v: string | null) {
    const t = parseTime(v);
    if (!t) return;
    this.pending = t;
    this.hour?.set(t[0]);
    this.minute?.set(t[1]);
  }
}

if (!customElements.get("time-wheel")) customElements.define("time-wheel", TimeWheel);
