import type { NotificationView, TopUpRowView, UsageRowView } from "../../shared/api";
import { dateTimeSgt, sgd } from "./format";

/** Rows asked for per page; a shorter page means there are no more. */
export const PAGE_SIZE = 20;

/** Where a list is up to. `offset` is the next `offset=` to ask for. */
export interface Paging {
  offset: number;
  done: boolean;
}

export const startPaging = (): Paging => ({ offset: 0, done: false });

/**
 * The state after a page of `got` rows arrived. "Load more" goes away when the page was short, or
 * (usage only, which reports `total`) when every row is already loaded.
 */
export function afterPage(p: Paging, got: number, total?: number): Paging {
  const offset = p.offset + got;
  return { offset, done: got < PAGE_SIZE || (total !== undefined && offset >= total) };
}

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Daikin's times are ISO strings with +08:00. One without a zone is Singapore time, never the browser's. */
export function parseDaikinTime(s: string): number | null {
  if (!s) return null;
  const iso = s.trim().replace(" ", "T");
  const ms = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** "30 Oct 2026, 23:00" in Singapore time, or a dash when missing. */
export function whenText(s: string): string {
  const ms = parseDaikinTime(s);
  return ms === null ? "—" : dateTimeSgt(ms);
}

export function usageText(r: UsageRowView): { start: string; end: string; minutes: string; amount: string } {
  return {
    start: whenText(r.starttime),
    end: r.endtime ? `Ended ${whenText(r.endtime)}` : "Still running",
    minutes: `${r.duration} min`,
    amount: sgd(r.amount),
  };
}

export function topUpText(r: TopUpRowView): { date: string; type: string; amount: string; status: string } {
  return {
    date: whenText(r.created_on),
    type: r.type,
    amount: sgd(r.amount),
    // Daikin's code 1 is a completed payment (seen on every real top-up); anything else is not confirmed.
    status: r.status === 1 ? "Paid" : "Not paid",
  };
}

export function notificationText(r: NotificationView): { title: string; message: string; date: string } {
  return { title: r.title, message: r.message, date: whenText(r.send_on) };
}
