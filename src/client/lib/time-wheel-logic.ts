// Pure rules behind the looping time wheel (lib/time-wheel.ts). Kept DOM-free so they can be tested.

export interface DigitResult {
  /** The number the column now shows. */
  value: number;
  /** Digits still waiting for a partner; "" when the entry is complete. */
  buffer: string;
  /** True when the entry is complete and focus should move to the next column. */
  advance: boolean;
}

/**
 * Two-digit typing, the same rule as Web Awesome's time input: a digit that can't start a two-digit value (3–9 for
 * hours, 6–9 for minutes) is taken at once; otherwise it waits for a second digit. A second digit that makes an
 * invalid number starts a new entry, so 2 then 5 in the hour column is 05.
 */
export function typeDigit(buffer: string, digit: string, max: number): DigitResult {
  const d = Number(digit);
  if (buffer === "") {
    if (d * 10 > max) return { value: d, buffer: "", advance: true };
    return { value: d, buffer: digit, advance: false };
  }
  const combined = Number(buffer + digit);
  if (combined <= max) return { value: combined, buffer: "", advance: true };
  return typeDigit("", digit, max);
}

/** `i` folded into 0..n-1, so the wheel loops past 23 or 59 back to 00. */
export function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** The signed number of rows from `from` to `to` going the short way round a loop of `n`. */
export function shortestStep(from: number, to: number, n: number): number {
  const d = wrap(to - from, n);
  return d > n / 2 ? d - n : d;
}

/** "HH:MM" (seconds ignored) as [hour, minute], or null when it isn't a valid time. */
export function parseTime(value: string | null | undefined): [number, number] | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
}

export function formatTime(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
