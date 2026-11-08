const TZ = 'Australia/Brisbane';

export function fmtTime(date: Date, opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }) {
  return date.toLocaleTimeString('en-AU', { timeZone: TZ, ...opts });
}

export function fmtDateTime(date: Date) {
  return date.toLocaleString('en-AU', {
    timeZone: TZ,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ago(date: Date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

/** Small inline SVG line chart with flood-threshold reference lines. */
export function sparkline(
  series: [number, number][],
  thresholds: { value: number | null; cls: string }[] = [],
  width = 240,
  height = 64,
) {
  if (series.length < 2) return '<p class="muted">Not enough recent readings for a chart.</p>';
  const xs = series.map((p) => p[0]);
  const ys = series.map((p) => p[1]);
  const visible = thresholds.filter((t) => t.value != null) as { value: number; cls: string }[];
  const yMin = Math.min(...ys);
  // Show the minor threshold only when the level is within 1 m of it, so normal days keep detail.
  const nearby = visible.filter((t) => t.value - Math.max(...ys) < 1);
  const yMax = Math.max(...ys, ...nearby.map((t) => t.value));
  const span = yMax - yMin || 1;
  const x = (t: number) => ((t - xs[0]) / (xs.at(-1)! - xs[0] || 1)) * width;
  const y = (v: number) => height - 4 - ((v - yMin) / span) * (height - 8);
  const d = series.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const lines = nearby
    .map((t) => `<line class="thr ${t.cls}" x1="0" x2="${width}" y1="${y(t.value)}" y2="${y(t.value)}" />`)
    .join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Water level trend">${lines}<path d="${d}" /></svg>`;
}
