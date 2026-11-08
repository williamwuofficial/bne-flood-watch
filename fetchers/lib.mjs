// Shared helpers for the data fetchers. Plain Node 22 (built-in fetch), no dependencies.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'public', 'data');

// Greater Brisbane, roughly Chermside (north) to Springwood (south), with some margin.
export const BBOX = { west: 152.85, south: -27.7, east: 153.25, north: -27.3 };

export const USER_AGENT = 'bne-flood-watch (+https://github.com/williamwuofficial/bne-flood-watch)';

export async function getJson(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.replace(/apikey=[^&]+/, 'apikey=…')}`);
  return res.json();
}

export async function readJson(relPath, fallback = null) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, relPath), 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(relPath, value) {
  const file = join(DATA_DIR, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

const round = (n) => Math.round(n * 1e5) / 1e5; // ~1 m precision; keeps files small

export function roundCoords(coords) {
  return typeof coords[0] === 'number' ? coords.map(round) : coords.map(roundCoords);
}

export function inBbox([lon, lat], b = BBOX) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

/** All [lon, lat] positions in any GeoJSON geometry (including GeometryCollection). */
export function positions(geom) {
  if (!geom) return [];
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(positions);
  const out = [];
  const walk = (c) => (typeof c[0] === 'number' ? out.push(c) : c.forEach(walk));
  walk(geom.coordinates);
  return out;
}

export function roundGeometry(geom) {
  if (geom.type === 'GeometryCollection') return { ...geom, geometries: geom.geometries.map(roundGeometry) };
  return { ...geom, coordinates: roundCoords(geom.coordinates) };
}
