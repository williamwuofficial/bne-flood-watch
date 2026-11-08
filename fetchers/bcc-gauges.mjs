// Brisbane City Council stream height gauges (CC BY 4.0), condensed to the latest reading per gauge
// plus a rolling 72-hour series. The raw open-data export is sparse (mostly nulls) and ~700 KB per
// 6 hours, so the browser reads this small file instead.
// Dataset: https://data.brisbane.qld.gov.au/explore/dataset/telemetry-sensors-rainfall-and-stream-heights-observations/
import { getJson, readJson, writeJson } from './lib.mjs';

const EXPORT =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/telemetry-sensors-rainfall-and-stream-heights-observations/exports/json';
const HISTORY_HOURS = 72;

export default async function fetchBccGauges() {
  const params = new URLSearchParams({
    select: 'gauge,location_name,measured,value,minor,moderate,major,geopoint',
    // BCC republishes roughly hourly; 24 h of overlap is plenty to merge with stored history.
    where: 'sensor_type="Stream Height AHD" and measured >= now(hours=-24)',
    order_by: 'measured',
  });
  const rows = await getJson(`${EXPORT}?${params}`, { timeoutMs: 60_000 });

  const prev = await readJson('latest/bcc-gauges.json', { features: [] });
  const prevSeries = new Map(prev.features.map((f) => [f.properties.id, f.properties.series ?? []]));

  const gauges = new Map();
  for (const r of rows) {
    if (!r.geopoint) continue;
    let g = gauges.get(r.gauge);
    if (!g) {
      g = {
        id: r.gauge,
        name: r.location_name,
        lon: r.geopoint.lon,
        lat: r.geopoint.lat,
        minor: r.minor,
        moderate: r.moderate,
        major: r.major,
        points: new Map((prevSeries.get(r.gauge) ?? []).map(([t, v]) => [t, v])),
      };
      gauges.set(r.gauge, g);
    }
    if (r.value !== null) g.points.set(Math.floor(Date.parse(r.measured) / 1000), r.value);
  }

  const cutoff = Date.now() / 1000 - HISTORY_HOURS * 3600;
  const features = [...gauges.values()].map((g) => {
    const series = [...g.points.entries()].filter(([t]) => t >= cutoff).sort((a, b) => a[0] - b[0]);
    const last = series.at(-1) ?? null;
    const hourAgo = last ? [...series].reverse().find(([t]) => t <= last[0] - 3600) : null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
      properties: {
        id: g.id,
        name: g.name,
        minor: g.minor,
        moderate: g.moderate,
        major: g.major,
        level: last?.[1] ?? null,
        observed: last?.[0] ?? null,
        change1h: last && hourAgo ? Math.round((last[1] - hourAgo[1]) * 100) / 100 : null,
        status: classify(last?.[1], g),
        series,
      },
    };
  });

  await writeJson('latest/bcc-gauges.json', { type: 'FeatureCollection', features });
  return { count: features.length, withReadings: features.filter((f) => f.properties.level !== null).length };
}

function classify(level, { minor, moderate, major }) {
  if (level == null) return 'unknown';
  if (major != null && level >= major) return 'major';
  if (moderate != null && level >= moderate) return 'moderate';
  if (minor != null && level >= minor) return 'minor';
  return 'below';
}
