import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { GeolocateControl, Map, NavigationControl, ScaleControl } from 'maplibre-gl';
import { BASEMAP, BOUNDS, DATA_URL, HOME } from './config';
import { renderForecast } from './forecast';
import { iconImg, loadIcons } from './icons';
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
// ─── Theme: saved light/dark choice, else follow the OS ───────────────────────────────────────
type Theme = 'light' | 'dark';
const THEME_KEY = 'bne-flood-watch:theme';
const osDark = window.matchMedia('(prefers-color-scheme: dark)');
/** The viewer's explicit choice, or null to follow the OS. Kept in memory too, for private mode. */
let chosenTheme: Theme | null = (() => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
})();
const osTheme = (): Theme => (osDark.matches ? 'dark' : 'light');
const effectiveTheme = (): Theme => chosenTheme ?? osTheme();
let mapTheme = effectiveTheme();
const map = new Map({
  container: 'map',
  style: BASEMAP[mapTheme],
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

async function installLayers() {
  await loadIcons(map);
  layersReady = true;
  for (const layer of LAYERS) {
    layer.add(map);
    setVisible(layer, isOn(layer));
  }
  setRainWindow(map, rainState.window);
}

async function setVisible(layer: Layer, on: boolean) {
  for (const id of layer.layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const extra = document.querySelector<HTMLElement>(`[data-extra-for="${layer.id}"]`);
  if (extra) extra.hidden = !on;
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
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>';

/** Sync page colours, the toggle button and the base map with the current theme. */
function applyTheme() {
  const theme = effectiveTheme();
  if (chosenTheme) document.documentElement.dataset.theme = chosenTheme;
  else delete document.documentElement.dataset.theme;

  const btn = $<HTMLButtonElement>('theme-toggle');
  const next = theme === 'dark' ? 'light' : 'dark';
  btn.innerHTML = theme === 'dark' ? SUN : MOON; // show the theme you'd switch to
  btn.setAttribute('aria-label', `Switch to ${next} theme`);
  btn.title = `Switch to ${next} theme`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');

  if (theme !== mapTheme) {
    mapTheme = theme;
    // Our sources and layers live on the style, so they're re-added once the new style loads.
    layersReady = false;
    map.setStyle(BASEMAP[theme]);
    map.once('style.load', installLayers);
  }
}

$('theme-toggle').addEventListener('click', () => {
  const next: Theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  // Choosing the OS's own theme clears the override, so the site goes back to following the OS.
  chosenTheme = next === osTheme() ? null : next;
  try {
    if (chosenTheme) localStorage.setItem(THEME_KEY, chosenTheme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* private mode: applies for this visit only */
  }
  applyTheme();
});
osDark.addEventListener('change', applyTheme);
applyTheme();

// ─── Layer panel ─────────────────────────────────────────────────────────────────────────────
function buildPanel() {
  for (const layer of LAYERS) {
    const row = document.createElement('label');
    row.className = 'layer-row';
    row.dataset.layer = layer.id;
    const marker = layer.icon ? iconImg(layer.icon, 18) : `<span class="swatch" style="--c:${layer.swatch}"></span>`;
    row.innerHTML = `
      <input type="checkbox" ${isOn(layer) ? 'checked' : ''} />
      ${marker}
      <span class="name">${layer.label}</span>
      <span class="err" hidden>!</span>`;
    const box = row.querySelector('input')!;
    box.addEventListener('change', () => {
      prefs[layer.id] = box.checked;
      savePrefs();
      if (layersReady) setVisible(layer, box.checked);
    });

    // Controls and legend for this layer sit directly under its row and show only while it's on.
    const extra = document.createElement('div');
    extra.className = 'layer-extra';
    extra.dataset.extraFor = layer.id;
    extra.hidden = !isOn(layer);
    if (layer.id === 'radar') extra.append($('radar-controls'));
    if (layer.id === 'rainfall') extra.append(buildRainControls());
    if (layer.legend) extra.insertAdjacentHTML('beforeend', layer.legend);

    const list = $(layer.group === 'live' ? 'live-layers' : 'history-layers');
    list.append(row);
    if (extra.childElementCount) list.append(extra);
  }
}

function buildRainControls() {
  const wrap = document.createElement('div');
  wrap.id = 'rain-controls';
  wrap.className = 'segmented';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Rainfall period');
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

// Panel sections remember whether they're open; on phones they all start closed to keep the map clear.
const SECTIONS_KEY = 'bne-flood-watch:sections';
const phone = window.matchMedia('(max-width: 640px)').matches;
let sectionState: Record<string, boolean> = {};
try {
  sectionState = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}');
} catch {
  /* ignore */
}
document.querySelectorAll<HTMLDetailsElement>('details.psec').forEach((d) => {
  const key = d.dataset.section!;
  d.open = phone ? false : (sectionState[key] ?? d.open);
  d.addEventListener('toggle', () => {
    if (phone) return;
    sectionState[key] = d.open;
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionState));
    } catch {
      /* ignore */
    }
  });
});

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
