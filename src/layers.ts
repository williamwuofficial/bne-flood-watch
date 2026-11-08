import type { FeatureCollection } from 'geojson';
import { Popup, type ExpressionSpecification, type GeoJSONSource, type Map, type MapGeoJSONFeature, type RasterTileSource } from 'maplibre-gl';
import { DATA_URL, STATIC_URL, arcgisTiles } from './config';

/** ['match', ['get', prop], k1, v1, …, fallback] built from a lookup table. */
const matchColour = (prop: string, table: Record<string, string>, fallback: string) =>
  ['match', ['get', prop], ...Object.entries(table).flat(), fallback] as unknown as ExpressionSpecification;
import { ago, esc, fetchJson, fmtDateTime, sparkline } from './util';

export interface Layer {
  id: string;
  label: string;
  group: 'live' | 'history';
  swatch: string;
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

export const STATUS_COLOURS = {
  below: '#16a34a',
  minor: '#eab308',
  moderate: '#f97316',
  major: '#dc2626',
  unknown: '#94a3b8',
};

const STATUS_LABEL = {
  below: 'Below flood level',
  minor: 'Minor flooding',
  moderate: 'Moderate flooding',
  major: 'Major flooding',
  unknown: 'No recent reading',
};

let gaugeData: FeatureCollection | null = null;

const gauges: Layer = {
  id: 'gauges',
  label: 'Creek & river gauges (BCC)',
  group: 'live',
  swatch: STATUS_COLOURS.below,
  defaultOn: true,
  layerIds: ['gauges'],
  add(map) {
    map.addSource('gauges', {
      type: 'geojson',
      data: gaugeData ?? { type: 'FeatureCollection', features: [] },
      attribution: 'Brisbane City Council (CC BY 4.0)',
    });
    map.addLayer({
      id: 'gauges',
      type: 'circle',
      source: 'gauges',
      layout: {
        visibility: 'none',
        'circle-sort-key': ['match', ['get', 'status'], 'major', 4, 'moderate', 3, 'minor', 2, 'below', 1, 0],
      },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 9],
        'circle-color': matchColour('status', STATUS_COLOURS, STATUS_COLOURS.unknown),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
    bindPopup(map, 'gauges', (f) => gaugePopup(f.properties as unknown as GaugeProps, f));
  },
  async show(map) {
    if (!gaugeData) gaugeData = await fetchJson(DATA_URL('latest/bcc-gauges.json'));
    map.getSource<GeoJSONSource>('gauges')?.setData(gaugeData!);
  },
};

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

// ─── Road events (QLDTraffic, via GitHub Actions) ────────────────────────────────────────────

const TRAFFIC_COLOURS = {
  Flooding: '#0284c7',
  Hazard: '#f59e0b',
  Crash: '#dc2626',
  Roadworks: '#78716c',
  'Special event': '#7c3aed',
};

let trafficData: FeatureCollection | null = null;

const traffic: Layer = {
  id: 'traffic',
  label: 'Road closures & hazards',
  group: 'live',
  swatch: TRAFFIC_COLOURS.Flooding,
  defaultOn: true,
  layerIds: ['traffic-line', 'traffic-point'],
  add(map) {
    map.addSource('traffic', {
      type: 'geojson',
      data: trafficData ?? { type: 'FeatureCollection', features: [] },
      attribution: 'State of Queensland (TMR) QLDTraffic (CC BY 4.0 AU)',
    });
    const colour = matchColour('type', TRAFFIC_COLOURS, '#64748b');
    // Roadworks are numerous and rarely storm-related, so they're drawn faintly.
    const isRoadworks: ExpressionSpecification = ['==', ['get', 'type'], 'Roadworks'];
    map.addLayer({
      id: 'traffic-line',
      type: 'line',
      source: 'traffic',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { visibility: 'none', 'line-cap': 'round' },
      paint: {
        'line-color': colour,
        'line-width': ['case', isRoadworks, 2, 4],
        'line-opacity': ['case', isRoadworks, 0.45, 0.9],
      },
    });
    map.addLayer({
      id: 'traffic-point',
      type: 'circle',
      source: 'traffic',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['case', isRoadworks, 4, 6],
        'circle-color': colour,
        'circle-opacity': ['case', isRoadworks, 0.5, 1],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
    const popup = (f: MapGeoJSONFeature) => {
      const p = f.properties as Record<string, string | null>;
      return `
        <h3>${esc(p.subtype || p.type)}</h3>
        <p class="status" style="--c:${TRAFFIC_COLOURS[p.type as keyof typeof TRAFFIC_COLOURS] ?? '#64748b'}">${esc(p.impact ?? p.type)}</p>
        <p><strong>${esc(p.road)}</strong>${p.locality ? `, ${esc(p.locality)}` : ''}</p>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
        ${p.advice ? `<p class="muted">${esc(p.advice)}</p>` : ''}
        ${p.updated ? `<p class="muted">Updated ${fmtDateTime(new Date(p.updated))}</p>` : ''}`;
    };
    bindPopup(map, 'traffic-line', popup);
    bindPopup(map, 'traffic-point', popup);
  },
  async show(map) {
    if (!trafficData) trafficData = await fetchJson(DATA_URL('latest/traffic.json'));
    map.getSource<GeoJSONSource>('traffic')?.setData(trafficData!);
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
  traffic,
  flood2022,
  historicRaster('flood-2011', 'Jan 2011 (state interim flood lines)', '2010To2011InterimFloodLines', '#2563eb', 0),
  historicRaster('flood-1974', 'Jan 1974 (Brisbane & Ipswich)', 'Floods_BrisbaneAndIpswich_1974', '#7c3aed', 50),
  historicRaster('flood-1893', 'Feb 1893 (Brisbane)', 'Floods_Brisbane_1893', '#0d9488', -60),
];

