import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { GeolocateControl, Map, NavigationControl, ScaleControl } from 'maplibre-gl';
import { BASEMAP, BOUNDS, DATA_URL, HOME } from './config';
import { renderForecast } from './forecast';
import {
  LAYERS,
  invalidatePipelineData,
  invalidateRadarFrames,
  radarState,
  rainState,
  setRadarFrame,
  setRainWindow,
  type Layer,
  type RainWindow,
} from './layers';
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
  setRainWindow(map, rainState.window);
}

async function setVisible(layer: Layer, on: boolean) {
  for (const id of layer.layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (layer.id === 'radar') $('radar-controls').hidden = !on;
  if (layer.id === 'rainfall') $('rain-controls').hidden = !on;
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
    // Each layer's extra controls sit directly under its own row.
    if (layer.id === 'radar') row.after($('radar-controls'));
    if (layer.id === 'rainfall') row.after(buildRainControls());
  }
}

function buildRainControls() {
  const wrap = document.createElement('div');
  wrap.id = 'rain-controls';
  wrap.className = 'segmented';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Rainfall period');
  wrap.hidden = true;
  const options: [RainWindow, string][] = [
    ['rain1h', '1 h'],
    ['rain3h', '3 h'],
    ['rain24h', '24 h'],
  ];
  const saved = prefs['rainWindow:rain1h'] ? 'rain1h' : prefs['rainWindow:rain3h'] ? 'rain3h' : 'rain24h';
  rainState.window = saved;
  for (const [value, label] of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(value === saved));
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      for (const [v] of options) prefs[`rainWindow:${v}`] = v === value;
      savePrefs();
      setRainWindow(map, value);
    });
    wrap.append(btn);
  }
  return wrap;
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

// ─── Header dialogs (official warnings, about & sources) ─────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('[data-dialog]').forEach((btn) => {
  const dlg = $<HTMLDialogElement>(btn.dataset.dialog!);
  btn.addEventListener('click', () => dlg.showModal());
});
document.querySelectorAll<HTMLDialogElement>('dialog.dlg').forEach((dlg) => {
  dlg.querySelector('.dlg-close')?.addEventListener('click', () => dlg.close());
  // Click on the backdrop closes it.
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
});

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
let lastGenerated: string | null = null;

/** Re-run show() for visible layers so they pick up freshly fetched data. */
function reshowVisible(filter: (l: Layer) => boolean) {
  if (!layersReady) return;
  for (const layer of LAYERS) if (isOn(layer) && layer.show && filter(layer)) setVisible(layer, true);
}

async function refreshFreshness() {
  const el = $('freshness');
  // New radar frames arrive every 10 minutes; don't yank the frame out from under a playing loop.
  if (!radarTimer) {
    invalidateRadarFrames();
    reshowVisible((l) => l.id === 'radar');
  }
  try {
    const s = await fetchJson<Status>(DATA_URL('status.json'));
    if (lastGenerated && s.generated !== lastGenerated) {
      invalidatePipelineData();
      reshowVisible((l) => l.id !== 'radar');
    }
    lastGenerated = s.generated;
    const failing = Object.entries(s.sources).filter(([, v]) => !v.ok).map(([k]) => k);
    const generated = new Date(s.generated);
    const stale = Date.now() - generated.getTime() > 45 * 60_000;
    el.className = `freshness ${stale || failing.length ? 'warn' : ''}`;
    el.textContent = `Data updated ${ago(generated)}${failing.length ? ` · ${failing.join(', ')} unavailable` : ''}`;
    $('about-status').textContent = el.textContent;
    el.title = Object.entries(s.sources)
      .map(([k, v]) => `${k}: ${v.ok ? 'ok' : `error: ${v.error}`}${v.lastSuccess ? `, last success ${new Date(v.lastSuccess).toLocaleString('en-AU')}` : ''}`)
      .join('\n');
  } catch {
    el.className = 'freshness warn';
    el.textContent = 'Data status unavailable';
  }
}

// ─── Offline support ─────────────────────────────────────────────────────────────────────────
function updateOnline() {
  $('offline').hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  updateOnline();
  refreshFreshness();
});
window.addEventListener('offline', updateOnline);
updateOnline();
// Service worker only in production builds: in dev it would cache Vite's modules and confuse HMR.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch((err) => {
    console.warn('Service worker registration failed', err);
  });
}

buildPanel();
refreshFreshness();
window.setInterval(refreshFreshness, 5 * 60_000);
