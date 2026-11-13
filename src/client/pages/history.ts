import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "../lib/theme";
import "../styles/history.css";
import type { NotificationView, TopUpRowView, UsageRowView } from "../../shared/api";
import { api } from "../lib/api";
import {
  afterPage,
  notificationText,
  PAGE_SIZE,
  startPaging,
  topUpText,
  usageText,
  type Paging,
} from "../lib/history-logic";
import { apiErrorText } from "../lib/settings-logic";
import { mountShell } from "../lib/shell";

type TabName = "usage" | "topups" | "notifications";
type Button = HTMLElement & { loading: boolean };

const main = mountShell("history");
const tpl = document.getElementById("history-main") as HTMLTemplateElement;
main.append(document.importNode(tpl.content, true));

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** One `div.row` from plain text. Every string is set with textContent: Daikin's text is untrusted. */
function row(main: [string, string], side?: [string, string], cls?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls ? `row ${cls}` : "row";
  const left = document.createElement("div");
  left.className = "main";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = main[0];
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = main[1];
  left.append(title, sub);
  el.append(left);
  if (side) {
    const right = document.createElement("div");
    right.className = "side";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = side[0];
    const small = document.createElement("span");
    small.className = "sub";
    small.textContent = side[1];
    right.append(value, small);
    el.append(right);
  }
  return el;
}

interface Page {
  rows: HTMLElement[];
  /** Set for usage only, which reports how many rows exist. */
  total?: number;
}

const FETCH: Record<TabName, (offset: number) => Promise<Page>> = {
  usage: async (offset) => {
    const r = await api<{ rows: UsageRowView[]; total: number }>("GET", `/api/usage?limit=${PAGE_SIZE}&offset=${offset}`);
    return {
      total: r.total,
      rows: r.rows.map((x) => {
        const t = usageText(x);
        return row([t.start, t.end], [t.amount, t.minutes]);
      }),
    };
  },
  topups: async (offset) => {
    const r = await api<TopUpRowView[]>("GET", `/api/topups?limit=${PAGE_SIZE}&offset=${offset}`);
    return {
      rows: r.map((x) => {
        const t = topUpText(x);
        return row([t.date, `${t.type} · ${t.status}`], [t.amount, ""]);
      }),
    };
  },
  notifications: async (offset) => {
    const r = await api<NotificationView[]>("GET", `/api/notifications?limit=${PAGE_SIZE}&offset=${offset}`);
    return {
      rows: r.map((x) => {
        const t = notificationText(x);
        return row([t.title, t.message], [t.date, ""], x.status ? undefined : "unread");
      }),
    };
  },
};

const EMPTY: Record<TabName, string> = {
  usage: "No aircon use yet.",
  topups: "No top-ups yet.",
  notifications: "No notifications yet.",
};

interface TabState {
  paging: Paging;
  loaded: boolean;
  busy: boolean;
  count: number;
}
const state: Record<TabName, TabState> = {
  usage: { paging: startPaging(), loaded: false, busy: false, count: 0 },
  topups: { paging: startPaging(), loaded: false, busy: false, count: 0 },
  notifications: { paging: startPaging(), loaded: false, busy: false, count: 0 },
};

async function load(tab: TabName): Promise<void> {
  const s = state[tab];
  if (s.busy || s.paging.done) return;
  s.busy = true;
  const more = $<Button>(`more-${tab}`);
  const note = $(`note-${tab}`);
  more.loading = true;
  note.hidden = true;
  note.classList.remove("error");
  try {
    const page = await FETCH[tab](s.paging.offset);
    s.paging = afterPage(s.paging, page.rows.length, page.total);
    s.loaded = true;
    s.count += page.rows.length;
    $(`list-${tab}`).append(...page.rows);
    if (s.count === 0) {
      note.textContent = EMPTY[tab];
      note.hidden = false;
    }
  } catch (err) {
    const text = apiErrorText(err);
    if (text) {
      note.textContent = text;
      note.classList.add("error");
      note.hidden = false;
    }
  } finally {
    s.busy = false;
    more.loading = false;
    // After a failed first load the button reads "Try again"; otherwise it goes once the last row is in.
    more.textContent = s.loaded ? "Load more" : "Try again";
    more.hidden = s.paging.done;
  }
}

for (const tab of Object.keys(state) as TabName[]) {
  $(`more-${tab}`).addEventListener("click", () => void load(tab));
}

const group = $("tabs");
group.addEventListener("wa-tab-show", (e) => {
  const name = (e as CustomEvent<{ name: TabName }>).detail.name;
  if (name in state && !state[name].loaded && !state[name].busy) void load(name);
});

void load("usage");
