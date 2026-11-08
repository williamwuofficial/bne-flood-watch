import type { Map } from 'maplibre-gl';

// Map icons, drawn as 32×32 SVG and rasterised at 2× for MapLibre. The same SVG is reused inline in
// the panel legends so the key always matches the map. Each has a white outline so it stays readable
// on both the light and dark base maps.

const OUTLINE = 'stroke="#fff" stroke-width="2.5"';
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;

/** Stream gauge: rounded square in the status colour with a column part-filled with water. */
const gauge = (fill: string) =>
  svg(`<rect x="3" y="3" width="26" height="26" rx="7" fill="${fill}" ${OUTLINE}/>
    <rect x="10.5" y="7.5" width="11" height="17" rx="2.5" fill="none" stroke="#fff" stroke-width="2"/>
    <path d="M10.5 16.5c1.8-1.4 3.7-1.4 5.5 0s3.7 1.4 5.5 0V22a2.5 2.5 0 0 1-2.5 2.5h-6a2.5 2.5 0 0 1-2.5-2.5z" fill="#fff"/>`);

/** Rain gauge: a droplet. */
const drop = (fill: string, stroke = '#fff') =>
  svg(`<path d="M16 3.5C11.5 10.5 7.5 15 7.5 20a8.5 8.5 0 0 0 17 0c0-5-4-9.5-8.5-16.5z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>`);

/** Small red "road closed" badge in the top-right corner. */
const CLOSED_BADGE = `<circle cx="25" cy="7" r="6" fill="#dc2626" stroke="#fff" stroke-width="2"/><path d="M21.8 7h6.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`;

const TRAFFIC_BODIES: Record<string, string> = {
  // Flooding: blue square with waves.
  flooding: `<rect x="3" y="3" width="26" height="26" rx="7" fill="#0284c7" ${OUTLINE}/>
    <path d="M8 13.5c2.7-2 5.3-2 8 0s5.3 2 8 0M8 19.5c2.7-2 5.3-2 8 0s5.3 2 8 0" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  // Hazard: amber warning triangle.
  hazard: `<path d="M16 3.5 29 27H3z" fill="#f59e0b" ${OUTLINE} stroke-linejoin="round"/>
    <path d="M16 11.5v7.5" stroke="#1f2937" stroke-width="2.8" stroke-linecap="round"/><circle cx="16" cy="23" r="1.7" fill="#1f2937"/>`,
  // Crash: red circle with a car.
  crash: `<circle cx="16" cy="16" r="13" fill="#dc2626" ${OUTLINE}/>
    <path d="M9 19.5v-3.2l2.2-4.6h9.6l2.2 4.6v3.2z" fill="#fff"/><circle cx="12" cy="20.5" r="1.9" fill="#fff"/><circle cx="20" cy="20.5" r="1.9" fill="#fff"/>
    <path d="M12.6 13.4h6.8l1.2 2.6h-9.2z" fill="#dc2626"/>`,
  // Roadworks: orange diamond with a traffic cone.
  roadworks: `<path d="M16 2.5 29.5 16 16 29.5 2.5 16z" fill="#ea580c" ${OUTLINE} stroke-linejoin="round"/>
    <path d="M14.4 9.5h3.2l3.4 11h-10z" fill="#fff"/><path d="M12.6 15.2h6.8" stroke="#ea580c" stroke-width="1.6"/><path d="M9.5 21.5h13" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
  // Special event: purple circle with a star.
  event: `<circle cx="16" cy="16" r="13" fill="#7c3aed" ${OUTLINE}/>
    <path d="m16 8.5 2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5-3.7-3.4 5-.6z" fill="#fff"/>`,
};

export const GAUGE_STATUS = {
  below: '#16a34a',
  minor: '#eab308',
  moderate: '#f97316',
  major: '#dc2626',
  unknown: '#94a3b8',
} as const;

/** mm thresholds → colour for rainfall totals. */
export const RAIN_RAMP: [number, string][] = [
  [0.2, '#bae6fd'],
  [5, '#38bdf8'],
  [15, '#2563eb'],
  [30, '#7c3aed'],
  [60, '#c026d3'],
  [100, '#e11d48'],
];

export const ICONS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(GAUGE_STATUS).map(([status, c]) => [`gauge-${status}`, gauge(c)])),
  'rain-dry': drop('none', '#7dd3fc'),
  'rain-off': drop('#cbd5e1', '#64748b'),
  ...Object.fromEntries(RAIN_RAMP.map(([, c], i) => [`rain-${i + 1}`, drop(c)])),
  ...Object.fromEntries(
    Object.entries(TRAFFIC_BODIES).flatMap(([k, body]) => [
      [`traffic-${k}`, svg(body)],
      [`traffic-${k}-closed`, svg(body + CLOSED_BADGE)],
    ]),
  ),
};

const dataUrl = (s: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;

/** Inline <img> of an icon, for legends. */
export function iconImg(name: string, size = 18, alt = '') {
  return `<img class="icon" src="${dataUrl(ICONS[name])}" width="${size}" height="${size}" alt="${alt}" />`;
}

const PIXEL_RATIO = 2;
const SIZE = 32 * PIXEL_RATIO;
const bitmaps = new globalThis.Map<string, ImageData>();

async function rasterise(name: string) {
  const cached = bitmaps.get(name);
  if (cached) return cached;
  const img = new Image(SIZE, SIZE);
  img.src = dataUrl(ICONS[name]);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE);
  bitmaps.set(name, data);
  return data;
}

/** Register every icon with the current style (needed again after a style swap). */
export async function loadIcons(map: Map) {
  const images = await Promise.all(Object.keys(ICONS).map(async (name) => [name, await rasterise(name)] as const));
  for (const [name, data] of images) if (!map.hasImage(name)) map.addImage(name, data, { pixelRatio: PIXEL_RATIO });
}
