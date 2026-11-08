import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { GeolocateControl, Map, NavigationControl, ScaleControl } from 'maplibre-gl';
import { BASEMAP, BOUNDS, DATA_URL, HOME } from './config';
import { renderForecast } from './forecast';
import { LAYERS, radarState, setRadarFrame, type Layer } from './layers';
import { ago, fetchJson, fmtTime } from './util';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ─── Persisted per-viewer preferences (best effort) ──────────────────────────────────────────
const PREFS_KEY = 'bne-flood-watch:layers';
function loadPrefs(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
const prefs = loadPrefs();
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode etc. */
  }
};
const isOn = (l: Layer) => prefs[l.id] ?? l.defaultOn;


// ─── Map ─────────────────────────────────────────────────────────────────────────────────────
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const map = new Map({
  container: 'map',
  style: dark.matches ? BASEMAP.dark : BASEMAP.light,
  center: HOME.center,
  zoom: HOME.zoom,
  maxBounds: [
    [151.9, -28.4],
    [154.2, -26.6],
  ],
  attributionControl: { compact: true },
});
if (import.meta.env.DEV) Object.assign(window, { map }); // handy for debugging in devtools
map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: false }, trackUserLocation: false }), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

// True once our sources/layers exist on the current style. (map.isStyleLoaded() is false while any
// tiles are still loading, so it can't be used to gate layer toggles.)
let layersReady = false;

function installLayers() {
  layersReady = true;
  for (const layer of LAYERS) {
    layer.add(map);
    setVisible(layer, isOn(layer));
  }
}

async function setVisible(layer: Layer, on: boolean) {
  for (const id of layer.layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (layer.id === 'radar') $('radar-controls').hidden = !on;
  if (!on && layer.id === 'radar') stopRadar();
  if (on && layer.show) {
    try {
      await layer.show(map);
      markLayerError(layer, null);
    } catch (err) {
      console.error(layer.id, err);
      markLayerError(layer, (err as Error).message);
    }
  }
}

map.on('load', () => {
  installLayers();
  // Keep the area clear of the side panel on wide screens.
  const panelWidth = window.matchMedia('(max-width: 640px)').matches ? 0 : 340;
  map.fitBounds(BOUNDS, { padding: { top: 20, bottom: 20, right: 20, left: 20 + panelWidth }, duration: 0, maxZoom: HOME.zoom });
});
// Follow the OS light/dark setting; layers must be re-added after a style swap.
dark.addEventListener('change', (e) => {
  layersReady = false;
  map.setStyle(e.matches ? BASEMAP.dark : BASEMAP.light);
  map.once('style.load', installLayers);
});

// ─── Layer panel ─────────────────────────────────────────────────────────────────────────────
function buildPanel() {
  for (const layer of LAYERS) {
    const row = document.createElement('label');
    row.className = 'layer-row';
    row.dataset.layer = layer.id;
    row.innerHTML = `
      <input type="checkbox" ${isOn(layer) ? 'checked' : ''} />
      <span class="swatch" style="--c:${layer.swatch}"></span>
      <span class="name">${layer.label}</span>
      <span class="err" hidden>!</span>`;
    const box = row.querySelector('input')!;
    box.addEventListener('change', () => {
      prefs[layer.id] = box.checked;
      savePrefs();
      if (layersReady) setVisible(layer, box.checked);
    });
    $(layer.group === 'live' ? 'live-layers' : 'history-layers').append(row);
  }
}

function markLayerError(layer: Layer, message: string | null) {
  const badge = document.querySelector<HTMLElement>(`[data-layer="${layer.id}"] .err`);
  if (!badge) return;
  badge.hidden = !message;
  badge.title = message ? `Couldn't load: ${message}` : '';
}

const panel = $('panel');
const toggle = $('panel-toggle');
toggle.addEventListener('click', () => {
  const open = panel.classList.toggle('collapsed') === false;
  toggle.setAttribute('aria-expanded', String(open));
});
if (window.matchMedia('(max-width: 640px)').matches) {
  panel.classList.add('collapsed');
  toggle.setAttribute('aria-expanded', 'false');
}

// ─── Radar animation ─────────────────────────────────────────────────────────────────────────
let radarTimer: number | undefined;
const slider = $<HTMLInputElement>('radar-slider');
const playBtn = $<HTMLButtonElement>('radar-play');

radarState.onChange = (frame) => {
  slider.max = String(radarState.frames.length - 1);
  slider.value = String(radarState.index);
  if (frame) $('radar-time').textContent = fmtTime(new Date(frame.time * 1000));
};
slider.addEventListener('input', () => {
  stopRadar();
  setRadarFrame(map, Number(slider.value));
});
function stopRadar() {
  window.clearInterval(radarTimer);
  radarTimer = undefined;
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', 'Play radar loop');
}
playBtn.addEventListener('click', () => {
  if (radarTimer) return stopRadar();
  playBtn.textContent = '⏸';
  playBtn.setAttribute('aria-label', 'Pause radar loop');
  radarTimer = window.setInterval(() => setRadarFrame(map, (radarState.index + 1) % radarState.frames.length), 700);
});

// ─── Forecast ────────────────────────────────────────────────────────────────────────────────
function forecastAt(lat: number, lon: number, label: string) {
  $('forecast-where').textContent = label;
  renderForecast($('forecast'), lat, lon);
}
forecastAt(-27.4698, 153.0251, '· Brisbane CBD');
map.on('contextmenu', (e) => forecastAt(e.lngLat.lat, e.lngLat.lng, `· ${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`));

// ─── Data freshness (from the Actions pipeline) ──────────────────────────────────────────────
interface Status {
  generated: string;
  sources: Record<string, { ok: boolean; lastSuccess?: string; error?: string | null }>;
}
async function refreshFreshness() {
  const el = $('freshness');
  try {
    const s = await fetchJson<Status>(DATA_URL('status.json'));
    const failing = Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k]) => k);
    const generated = new Date(s.generated);
    const stale = Date.now() - generated.getTime() > 45 * 60_000;
    el.className = `freshness ${stale || failing.length ? 'warn' : ''}`;
    el.textContent = `Data updated ${ago(generated)}${failing.length ? ` · ${failing.join(', ')} unavailable` : ''}`;
    el.title = Object.entries(s.sources)
      .map(([k, v]) => `${k}: ${v.ok ? 'ok' : `error: ${v.error}`}${v.lastSuccess ? `, last success ${new Date(v.lastSuccess).toLocaleString('en-AU')}` : ''}`)
      .join('\n');
  } catch {
    el.className = 'freshness warn';
    el.textContent = 'Data status unavailable';
  }
}

buildPanel();
refreshFreshness();
window.setInterval(refreshFreshness, 5 * 60_000);
