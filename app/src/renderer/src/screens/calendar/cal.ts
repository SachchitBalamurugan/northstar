// Date math + layout helpers for the calendar views. Local time throughout.
export type View = "day" | "week" | "month";
export const HOUR_PX = 52;           // height of one hour in day/week grids
export const DAY_MS = 864e5;

export const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -startOfDay(d).getDay()); // Sunday-first
export const startOfMonth = (d: Date) => { const x = startOfDay(d); x.setDate(1); return x; };

/** Visible [from, to) window and the list of days for a view. Month = 6 full weeks. */
export function range(view: View, cursor: Date): { from: Date; to: Date; days: Date[] } {
  if (view === "day") { const f = startOfDay(cursor); return { from: f, to: addDays(f, 1), days: [f] }; }
  if (view === "week") { const f = startOfWeek(cursor); return { from: f, to: addDays(f, 7), days: Array.from({ length: 7 }, (_, i) => addDays(f, i)) }; }
  const f = startOfWeek(startOfMonth(cursor));
  return { from: f, to: addDays(f, 42), days: Array.from({ length: 42 }, (_, i) => addDays(f, i)) };
}

export function step(view: View, cursor: Date, dir: 1 | -1): Date {
  return view === "day" ? addDays(cursor, dir) : view === "week" ? addDays(cursor, 7 * dir) : addMonths(cursor, dir);
}

export function title(view: View, cursor: Date): string {
  if (view === "day") return cursor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (view === "month") return cursor.toLocaleDateString([], { month: "long", year: "numeric" });
  const f = startOfWeek(cursor), l = addDays(f, 6);
  const sameMonth = f.getMonth() === l.getMonth();
  return `${f.toLocaleDateString([], { month: "short", day: "numeric" })} – ${l.toLocaleDateString([], sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}, ${l.getFullYear()}`;
}

export const timeLabel = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const hourLabel = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Value for <input type="datetime-local"> and back. */
export const toLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const fromLocalInput = (v: string) => new Date(v).toISOString();

/**
 * Side-by-side layout for overlapping timed events in one day column.
 * Returns each event with a column index and the total columns in its overlap cluster.
 */
export function layoutDay<T extends { start: string; end: string }>(events: T[]): { ev: T; col: number; cols: number }[] {
  const sorted = [...events].sort((a, b) => +new Date(a.start) - +new Date(b.start) || +new Date(b.end) - +new Date(a.end));
  const out: { ev: T; col: number; cols: number }[] = [];
  let cluster: { ev: T; col: number; cols: number }[] = [], colEnds: number[] = [], clusterEnd = -Infinity;
  const flush = () => { const n = colEnds.length; cluster.forEach(c => (c.cols = n)); out.push(...cluster); cluster = []; colEnds = []; };
  for (const ev of sorted) {
    const s = +new Date(ev.start), e = Math.max(+new Date(ev.end), s + 15 * 60e3);
    if (s >= clusterEnd && cluster.length) flush();
    let col = colEnds.findIndex(end => end <= s);
    if (col < 0) { col = colEnds.length; colEnds.push(e); } else colEnds[col] = e;
    cluster.push({ ev, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (cluster.length) flush();
  return out;
}
