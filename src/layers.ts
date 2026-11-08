import type { FeatureCollection } from 'geojson';
import { Popup, type ExpressionSpecification, type GeoJSONSource, type Map, type MapGeoJSONFeature, type RasterTileSource } from 'maplibre-gl';
import { DATA_URL, STATIC_URL, arcgisTiles } from './config';
import { GAUGE_STATUS, RAIN_RAMP, iconImg } from './icons';
import { ago, esc, fetchJson, fmtDateTime, sparkline } from './util';

/** ['match', ['get', prop], k1, v1, …, fallback] built from a lookup table. */
const matchColour = (prop: string, table: Record<string, string>, fallback: string) =>
  ['match', ['get', prop], ...Object.entries(table).flat(), fallback] as unknown as ExpressionSpecification;

/**
 * Icons scale gently with zoom so dense areas stay legible when zoomed out. `scale` lets a layer
 * shrink less important features. (MapLibre only allows ['zoom'] at the top level of an
 * interpolate, so the per-feature scale goes inside each stop.)
 */
function iconSize(scale?: ExpressionSpecification): ExpressionSpecification {
  const stop = (base: number) => (scale ? ['*', base, scale] : base);
  return ['interpolate', ['linear'], ['zoom'], 9, stop(0.62), 12, stop(0.8), 15, stop(1)] as unknown as ExpressionSpecification;
}
const ICON_SIZE = iconSize();

// ─── Data produced by the Actions pipeline (data/latest/*.json) ───────────────────────────────
// globalThis.Map: the MapLibre `Map` import shadows the built-in one in this module.
const pipelineCache = new globalThis.Map<string, FeatureCollection>();
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

async function pipelineData(path: string) {
  if (!pipelineCache.has(path)) pipelineCache.set(path, await fetchJson<FeatureCollection>(DATA_URL(path)));
  return pipelineCache.get(path)!;
}

/** Forget cached pipeline snapshots so the next show() fetches fresh copies. */
export function invalidatePipelineData() {
  pipelineCache.clear();
}

/** Forget the radar frame list so the next show() picks up new frames (RainViewer adds one every 10 min). */
export function invalidateRadarFrames() {
  radarState.frames = [];
}

export interface Layer {
  id: string;
  label: string;
  group: 'live' | 'history';
  swatch: string;
  /** Icon shown in the panel row instead of the colour swatch. */
  icon?: string;
  /** Legend HTML shown under the row while the layer is on. */
  legend?: string;
  defaultOn: boolean;
  /** Adds sources/layers (hidden). Called once after each style load. */
  add(map: Map): void;
  /** Called when toggled on; lazy-loads data the first time. */
  show?(map: Map): Promise<void> | void;
  layerIds: string[];
}

/** Insert overlays below the basemap's first symbol layer so road/place labels stay readable. */
function beforeLabels(map: Map) {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

// ─── Historic flood extents ────────────────────────────────────────────────────────────────────

function historicRaster(id: string, label: string, service: string, swatch: string, hueRotate: number): Layer {
  return {
    id,
    label,
    group: 'history',
    swatch,
    defaultOn: false,
    layerIds: [id],
    add(map) {
      map.addSource(id, {
        type: 'raster',
        tiles: [arcgisTiles(service)],
        tileSize: 256,
        bounds: [152.6, -27.9, 153.5, -27.1],
        attribution: '© State of Queensland (Queensland Spatial)',
      });
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.55, 'raster-hue-rotate': hueRotate },
        },
        beforeLabels(map),
      );
    },
  };
}

const flood2022: Layer = {
  id: 'flood-2022',
  label: 'Feb 2022 (Brisbane River & creeks)',
  group: 'history',
  swatch: '#dc2626',
  defaultOn: true,
  layerIds: ['flood-2022-fill', 'flood-2022-line'],
  add(map) {
    map.addSource('flood-2022', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: 'Brisbane City Council (CC BY 4.0)',
    });
    const before = beforeLabels(map);
    map.addLayer(
      {
        id: 'flood-2022-fill',
        type: 'fill',
        source: 'flood-2022',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.22 },
      },
      before,
    );
    map.addLayer(
      {
        id: 'flood-2022-line',
        type: 'line',
        source: 'flood-2022',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#b91c1c', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 1.5] },
      },
      before,
    );
  },
  async show(map) {
    // Fetched lazily (≈270 KB gzipped); the browser cache makes re-adding after a theme switch cheap.
    await map.getSource<GeoJSONSource>('flood-2022')?.setData(STATIC_URL('flood-2022-feb.geojson'));
  },
};

// ─── Rain radar (RainViewer) ───────────────────────────────────────────────────────────────────

interface RainViewerIndex {
  host: string;
  radar: { past: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] };
}

export const radarState = {
  frames: [] as { time: number; url: string }[],
  index: 0,
  onChange: (_frame: { time: number; url: string } | undefined) => {},
};

async function loadRadarFrames() {
  const idx = await fetchJson<RainViewerIndex>('https://api.rainviewer.com/public/weather-maps.json');
  // Free tier serves zoom ≤ 7; MapLibre over-zooms beyond that. Colour scheme 2 = Universal Blue.
  radarState.frames = [...idx.radar.past, ...(idx.radar.nowcast ?? [])].map((f) => ({
    time: f.time,
    url: `${idx.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
  }));
  radarState.index = radarState.frames.length - 1 - (idx.radar.nowcast?.length ?? 0);
}

export function setRadarFrame(map: Map, i: number) {
  const frame = radarState.frames[i];
  if (!frame) return;
  radarState.index = i;
  map.getSource<RasterTileSource>('radar')?.setTiles([frame.url]);
  radarState.onChange(frame);
}

const radar: Layer = {
  id: 'radar',
  label: 'Rain radar',
  group: 'live',
  swatch: '#3b82f6',
  defaultOn: true,
  layerIds: ['radar'],
  add(map) {
    // The source needs a tile URL, so it's only created once the frame list has loaded (see show()).
    if (radarState.frames.length) addRadarSource(map, 'none');
  },
  async show(map) {
    if (!radarState.frames.length) await loadRadarFrames();
    if (!map.getSource('radar')) addRadarSource(map, 'visible');
    setRadarFrame(map, radarState.index);
  },
};

function addRadarSource(map: Map, visibility: 'visible' | 'none') {
  map.addSource('radar', {
    type: 'raster',
    tiles: [radarState.frames[radarState.index].url],
    tileSize: 256,
    maxzoom: 7,
    attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
  });
  map.addLayer(
    { id: 'radar', type: 'raster', source: 'radar', layout: { visibility }, paint: {
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.75, 12, 0.55],
        'raster-fade-duration': 0,
        // RainViewer's free tier stops at zoom 7 (~1.2 km pixels). Show those pixels as crisp cells
        // rather than smearing them into blobs, so they read as low-resolution data, not a glitch.
        'raster-resampling': 'nearest',
      } },
    beforeLabels(map),
  );
}

// ─── Creek & river gauges (BCC, via GitHub Actions) ──────────────────────────────────────────

interface GaugeProps {
  id: string;
  name: string;
  minor: number | null;
  moderate: number | null;
  major: number | null;
  level: number | null;
  observed: number | null;
  change1h: number | null;
  status: 'below' | 'minor' | 'moderate' | 'major' | 'unknown';
  series: [number, number][];
}

export const STATUS_COLOURS = GAUGE_STATUS;

const STATUS_LABEL = {
  below: 'Below flood level',
  minor: 'Minor flooding',
  moderate: 'Moderate flooding',
  major: 'Major flooding',
  unknown: 'No recent reading',
};

const gauges: Layer = {
  id: 'gauges',
  label: 'Creek & river levels (BCC)',
  group: 'live',
  swatch: STATUS_COLOURS.below,
  icon: 'gauge-below',
  legend: legendList([
    ['gauge-below', 'Below flood level'],
    ['gauge-minor', 'Minor'],
    ['gauge-moderate', 'Moderate'],
    ['gauge-major', 'Major'],
    ['gauge-unknown', 'No reading'],
  ]),
  defaultOn: true,
  layerIds: ['gauges'],
  add(map) {
    map.addSource('gauges', {
      type: 'geojson',
      data: pipelineCache.get('latest/bcc-gauges.json') ?? EMPTY,
      attribution: 'Brisbane City Council (CC BY 4.0)',
    });
    map.addLayer({
      id: 'gauges',
      type: 'symbol',
      source: 'gauges',
      layout: {
        visibility: 'none',
        'icon-image': ['concat', 'gauge-', ['get', 'status']],
        'icon-size': ICON_SIZE,
        'icon-allow-overlap': true,
        // Flooding gauges draw on top.
        'symbol-sort-key': ['match', ['get', 'status'], 'major', 4, 'moderate', 3, 'minor', 2, 'below', 1, 0],
      },
    });
    bindPopup(map, 'gauges', (f) => gaugePopup(f.properties as unknown as GaugeProps, f));
  },
  async show(map) {
    map.getSource<GeoJSONSource>('gauges')?.setData(await pipelineData('latest/bcc-gauges.json'));
  },
};

/** Legend: rows of [icon name, label]. */
function legendList(items: [string, string][]) {
  return `<ul class="legend">${items.map(([icon, label]) => `<li>${iconImg(icon, 16)}<span>${esc(label)}</span></li>`).join('')}</ul>`;
}

function gaugePopup(p: GaugeProps, f: MapGeoJSONFeature) {
  // MapLibre stringifies nested arrays in feature properties.
  const series: [number, number][] = typeof f.properties.series === 'string' ? JSON.parse(f.properties.series) : p.series;
  const trend =
    p.change1h == null ? '' : p.change1h > 0.02 ? `▲ rising ${p.change1h.toFixed(2)} m/h` : p.change1h < -0.02 ? `▼ falling ${Math.abs(p.change1h).toFixed(2)} m/h` : '● steady';
  const nullNum = (v: unknown) => (v === null || v === 'null' || v === undefined ? null : Number(v));
  return `
    <h3>${esc(p.name)}</h3>
    <p class="status" style="--c:${STATUS_COLOURS[p.status]}">${STATUS_LABEL[p.status]}</p>
    ${p.level != null ? `<p class="big">${Number(p.level).toFixed(2)} m <small>AHD</small> <span class="trend">${trend}</span></p>` : ''}
    ${p.observed ? `<p class="muted">Reading ${fmtDateTime(new Date(Number(p.observed) * 1000))} (${ago(new Date(Number(p.observed) * 1000))})</p>` : ''}
    ${sparkline(series, [
      { value: nullNum(p.minor), cls: 'minor' },
      { value: nullNum(p.moderate), cls: 'moderate' },
      { value: nullNum(p.major), cls: 'major' },
    ])}
    <p class="thresholds">Minor ${p.minor ?? '–'} · Moderate ${p.moderate ?? '–'} · Major ${p.major ?? '–'} m</p>
    <p class="muted">Gauge ${esc(p.id)} · last 72 h</p>`;
}

// ─── Rainfall gauges (BCC, via GitHub Actions) ───────────────────────────────────────────────

export type RainWindow = 'rain1h' | 'rain3h' | 'rain24h';
export const rainState = { window: 'rain24h' as RainWindow };

function rainIcon(win: RainWindow): ExpressionSpecification {
  const steps = RAIN_RAMP.flatMap(([mm], i) => [mm, `rain-${i + 1}`]);
  return ['case', ['!', ['get', 'reporting']], 'rain-off', ['step', ['get', win], 'rain-dry', ...steps]] as unknown as ExpressionSpecification;
}

function rainLabel(win: RainWindow): ExpressionSpecification {
  return ['case', ['>=', ['get', win], 0.2], ['number-format', ['get', win], { 'max-fraction-digits': 1 }], ''] as unknown as ExpressionSpecification;
}

/** Dry or silent gauges are drawn small so a dry day doesn't bury the map in droplets. */
function rainSize(win: RainWindow): ExpressionSpecification {
  return iconSize(['case', ['all', ['get', 'reporting'], ['>=', ['get', win], 0.2]], 1, 0.6] as unknown as ExpressionSpecification);
}

export function setRainWindow(map: Map, win: RainWindow) {
  rainState.window = win;
  if (!map.getLayer('rain')) return;
  map.setLayoutProperty('rain', 'icon-image', rainIcon(win));
  map.setLayoutProperty('rain', 'icon-size', rainSize(win));
  map.setLayoutProperty('rain', 'text-field', rainLabel(win));
  map.setLayoutProperty('rain', 'symbol-sort-key', ['get', win]);
}

const RAIN_LEGEND = (() => {
  const bands = RAIN_RAMP.map(([mm], i) => {
    const next = RAIN_RAMP[i + 1]?.[0];
    return [`rain-${i + 1}`, next ? `${mm}–${next} mm` : `${mm}+ mm`] as [string, string];
  });
  return legendList([['rain-dry', 'Dry'], ...bands, ['rain-off', 'No reading']]);
})();

const rainfall: Layer = {
  id: 'rainfall',
  label: 'Rainfall totals (BCC)',
  group: 'live',
  swatch: '#38bdf8',
  icon: 'rain-2',
  legend: RAIN_LEGEND,
  defaultOn: false,
  layerIds: ['rain'],
  add(map) {
    map.addSource('rainfall', {
      type: 'geojson',
      data: pipelineCache.get('latest/bcc-rainfall.json') ?? EMPTY,
      attribution: 'Brisbane City Council (CC BY 4.0)',
    });
    const win = rainState.window;
    map.addLayer({
      id: 'rain',
      type: 'symbol',
      source: 'rainfall',
      layout: {
        visibility: 'none',
        'icon-image': rainIcon(win),
        'icon-size': rainSize(win),
        'icon-allow-overlap': true,
        'symbol-sort-key': ['get', win],
        'text-field': rainLabel(win),
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-anchor': 'left',
        'text-offset': [0.9, 0],
        'text-allow-overlap': true,
        'text-optional': true,
      },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
    bindPopup(map, 'rain', (f) => {
      const p = f.properties as Record<string, number | string | boolean | null>;
      const asOf = p.lastReport ? new Date(Number(p.lastReport) * 1000) : null;
      return `
        <h3>${esc(p.name)}</h3>
        <p class="muted">Rain gauge ${esc(p.id)}</p>
        <dl class="rain-grid">
          <div><dt>Last 1 h</dt><dd>${p.rain1h} mm</dd></div>
          <div><dt>Last 3 h</dt><dd>${p.rain3h} mm</dd></div>
          <div><dt>Last 24 h</dt><dd>${p.rain24h} mm</dd></div>
        </dl>
        <p class="muted">${asOf ? `Last report ${fmtDateTime(asOf)} (${ago(asOf)})` : 'No reports in the last 24 h'}</p>`;
    });
  },
  async show(map) {
    map.getSource<GeoJSONSource>('rainfall')?.setData(await pipelineData('latest/bcc-rainfall.json'));
  },
};

// ─── Road events (QLDTraffic, via GitHub Actions) ────────────────────────────────────────────

const TRAFFIC_COLOURS = {
  Flooding: '#0284c7',
  Hazard: '#f59e0b',
  Crash: '#dc2626',
  Roadworks: '#ea580c',
  'Special event': '#7c3aed',
};
const TRAFFIC_ICON_KEY: Record<string, string> = {
  Flooding: 'flooding',
  Hazard: 'hazard',
  Crash: 'crash',
  Roadworks: 'roadworks',
  'Special event': 'event',
};
/** Higher draws on top: storm-relevant events above roadworks. */
const TRAFFIC_PRIORITY: Record<string, number> = { Flooding: 5, Crash: 4, Hazard: 3, 'Special event': 2, Roadworks: 1 };

type Position = number[];

/** One icon per event: each point of a (multi)point, or the middle of the longest line. */
function iconAnchors(geom: GeoJSON.Geometry | null): Position[] {
  if (!geom) return [];
  switch (geom.type) {
    case 'Point':
      return [geom.coordinates];
    case 'MultiPoint':
      return geom.coordinates;
    case 'LineString':
      return [geom.coordinates[Math.floor(geom.coordinates.length / 2)]];
    case 'MultiLineString': {
      const longest = geom.coordinates.reduce((a, b) => (b.length > a.length ? b : a), []);
      return longest.length ? [longest[Math.floor(longest.length / 2)]] : [];
    }
    case 'GeometryCollection':
      return iconAnchors(geom.geometries.find((g) => iconAnchors(g).length) ?? null);
    default:
      return [];
  }
}

function trafficIcons(fc: FeatureCollection): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.flatMap((f) => {
      const p = f.properties ?? {};
      const closed = /closed/i.test(String(p.impact ?? ''));
      const icon = `traffic-${TRAFFIC_ICON_KEY[p.type] ?? 'hazard'}${closed ? '-closed' : ''}`;
      return iconAnchors(f.geometry).map((coordinates) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates },
        properties: { ...p, icon, closed, priority: (TRAFFIC_PRIORITY[p.type] ?? 2) + (closed ? 0.5 : 0) },
      }));
    }),
  };
}

const LINE_TYPES = ['literal', ['LineString', 'MultiLineString']] as unknown as ExpressionSpecification;

const traffic: Layer = {
  id: 'traffic',
  label: 'Road closures & hazards',
  group: 'live',
  swatch: TRAFFIC_COLOURS.Flooding,
  icon: 'traffic-flooding',
  legend: legendList([
    ['traffic-flooding', 'Flooding'],
    ['traffic-hazard', 'Hazard'],
    ['traffic-crash', 'Crash'],
    ['traffic-roadworks', 'Roadworks'],
    ['traffic-event', 'Special event'],
    ['traffic-hazard-closed', 'Road closed'],
  ]),
  defaultOn: true,
  layerIds: ['traffic-line', 'traffic-icons'],
  add(map) {
    map.addSource('traffic', {
      type: 'geojson',
      data: pipelineCache.get('latest/traffic.json') ?? EMPTY,
      attribution: 'State of Queensland (TMR) QLDTraffic (CC BY 4.0 AU)',
    });
    const cached = pipelineCache.get('latest/traffic.json');
    map.addSource('traffic-icons', { type: 'geojson', data: cached ? trafficIcons(cached) : EMPTY });
    const isRoadworks: ExpressionSpecification = ['==', ['get', 'type'], 'Roadworks'];
    // Affected road sections, under the icons. Roadworks are numerous and rarely storm-related,
    // so they're drawn faintly and dashed.
    map.addLayer({
      id: 'traffic-line',
      type: 'line',
      source: 'traffic',
      filter: ['in', ['geometry-type'], LINE_TYPES],
      layout: { visibility: 'none', 'line-cap': 'round' },
      paint: {
        'line-color': matchColour('type', TRAFFIC_COLOURS, '#64748b'),
        'line-width': ['case', isRoadworks, 2, 4],
        'line-opacity': ['case', isRoadworks, 0.45, 0.85],
        'line-dasharray': ['case', isRoadworks, ['literal', [2, 2]], ['literal', [1, 0]]],
      },
    });
    map.addLayer({
      id: 'traffic-icons',
      type: 'symbol',
      source: 'traffic-icons',
      layout: {
        visibility: 'none',
        'icon-image': ['get', 'icon'],
        'icon-size': iconSize(['case', isRoadworks, 0.8, 1]),
        'icon-allow-overlap': true,
        'symbol-sort-key': ['get', 'priority'],
      },
      paint: { 'icon-opacity': ['case', isRoadworks, 0.75, 1] },
    });
    const popup = (f: MapGeoJSONFeature) => {
      const p = f.properties as Record<string, string | null>;
      return `
        <h3>${iconImg(String(p.icon ?? 'traffic-hazard'), 20)} ${esc(p.subtype || p.type)}</h3>
        <p class="status" style="--c:${TRAFFIC_COLOURS[p.type as keyof typeof TRAFFIC_COLOURS] ?? '#64748b'}">${esc(p.impact ?? p.type)}</p>
        <p><strong>${esc(p.road)}</strong>${p.locality ? `, ${esc(p.locality)}` : ''}</p>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        ${p.advice ? `<p class="muted">${esc(p.advice)}</p>` : ''}
        ${p.updated ? `<p class="muted">Updated ${fmtDateTime(new Date(p.updated))}</p>` : ''}`;
    };
    bindPopup(map, 'traffic-icons', popup);
  },
  async show(map) {
    const data = await pipelineData('latest/traffic.json');
    map.getSource<GeoJSONSource>('traffic')?.setData(data);
    map.getSource<GeoJSONSource>('traffic-icons')?.setData(trafficIcons(data));
  },
};

function bindPopup(map: Map, layerId: string, html: (f: MapGeoJSONFeature) => string) {
  map.on('click', layerId, (e) => {
    const f = e.features?.[0];
    if (!f) return;
    new Popup({ maxWidth: '300px', className: 'info-popup' }).setLngLat(e.lngLat).setHTML(html(f)).addTo(map);
  });
  map.on('mouseenter', layerId, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', layerId, () => (map.getCanvas().style.cursor = ''));
}

export const LAYERS: Layer[] = [
  radar,
  gauges,
  rainfall,
  traffic,
  flood2022,
  historicRaster('flood-2011', 'Jan 2011 (state interim flood lines)', '2010To2011InterimFloodLines', '#2563eb', 0),
  historicRaster('flood-1974', 'Jan 1974 (Brisbane & Ipswich)', 'Floods_BrisbaneAndIpswich_1974', '#7c3aed', 50),
  historicRaster('flood-1893', 'Feb 1893 (Brisbane)', 'Floods_Brisbane_1893', '#0d9488', -60),
];

