import { describe, expect, it } from "vitest";
import { formatTime, parseTime, shortestStep, typeDigit, wrap } from "../src/client/lib/time-wheel-logic";

/** Types each digit in turn, as a user would, and returns every result. */
function typeAll(keys: string, max: number) {
  let buffer = "";
  return [...keys].map((k) => {
    const r = typeDigit(buffer, k, max);
    buffer = r.buffer;
    return r;
  });
}

describe("typeDigit (hours, 00–23)", () => {
  it("takes 3–9 at once and moves on", () => {
    for (const k of "3456789") expect(typeDigit("", k, 23)).toEqual({ value: Number(k), buffer: "", advance: true });
  });

  it("waits after 0, 1 or 2", () => {
    for (const k of "012") expect(typeDigit("", k, 23)).toEqual({ value: Number(k), buffer: k, advance: false });
  });

  it("2 then 2 is 22", () => {
    expect(typeAll("22", 23).at(-1)).toEqual({ value: 22, buffer: "", advance: true });
  });

  it("0 then 7 is 07", () => {
    expect(typeAll("07", 23).at(-1)).toEqual({ value: 7, buffer: "", advance: true });
  });

  it("2 then 5 starts again from the 5", () => {
    expect(typeAll("25", 23).at(-1)).toEqual({ value: 5, buffer: "", advance: true });
  });

  it("1 then 2 is 12, 2 then 3 is 23", () => {
    expect(typeAll("12", 23).at(-1)?.value).toBe(12);
    expect(typeAll("23", 23).at(-1)?.value).toBe(23);
  });

  it("2 then 0 is 20", () => {
    expect(typeAll("20", 23).at(-1)?.value).toBe(20);
  });
});

describe("typeDigit (minutes, 00–59)", () => {
  it("takes 6–9 at once and moves on", () => {
    for (const k of "6789") expect(typeDigit("", k, 59)).toEqual({ value: Number(k), buffer: "", advance: true });
  });

  it("waits after 0–5", () => {
    for (const k of "012345") expect(typeDigit("", k, 59).advance).toBe(false);
  });

  it("3 then 7 is 37", () => {
    expect(typeAll("37", 59).at(-1)).toEqual({ value: 37, buffer: "", advance: true });
  });

  it("5 then 9 is 59, 0 then 0 is 00", () => {
    expect(typeAll("59", 59).at(-1)?.value).toBe(59);
    expect(typeAll("00", 59).at(-1)).toEqual({ value: 0, buffer: "", advance: true });
  });
});

describe("wrap", () => {
  it("loops past either end", () => {
    expect(wrap(24, 24)).toBe(0);
    expect(wrap(-1, 24)).toBe(23);
    expect(wrap(61, 60)).toBe(1);
    expect(wrap(-169, 24)).toBe(23);
  });
});

describe("shortestStep", () => {
  it("goes the short way round", () => {
    expect(shortestStep(22, 1, 24)).toBe(3);
    expect(shortestStep(1, 22, 24)).toBe(-3);
    expect(shortestStep(10, 14, 24)).toBe(4);
    expect(shortestStep(14, 10, 24)).toBe(-4);
    expect(shortestStep(5, 5, 24)).toBe(0);
    expect(shortestStep(58, 2, 60)).toBe(4);
  });
});

describe("parseTime / formatTime", () => {
  it("reads HH:MM and ignores seconds", () => {
    expect(parseTime("22:30")).toEqual([22, 30]);
    expect(parseTime("07:05:00")).toEqual([7, 5]);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "7:05", "24:00", "12:60", "ab:cd", null, undefined]) expect(parseTime(bad)).toBeNull();
  });

  it("pads to HH:MM", () => {
    expect(formatTime(7, 5)).toBe("07:05");
    expect(formatTime(23, 59)).toBe("23:59");
  });
});
