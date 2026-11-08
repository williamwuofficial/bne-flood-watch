// Brisbane City Council rainfall gauges (CC BY 4.0): rain totals over the last 1 h, 3 h and 24 h.
// Each observation is the rain that fell in that reporting interval (mm), so totals are sums.
// BCC republishes roughly hourly, so totals are "to the latest published reading", not to now.
// Dataset: https://data.brisbane.qld.gov.au/explore/dataset/telemetry-sensors-rainfall-and-stream-heights-observations/
import { getJson, writeJson } from './lib.mjs';

const EXPORT =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/telemetry-sensors-rainfall-and-stream-heights-observations/exports/json';
const WINDOWS = { rain1h: 1, rain3h: 3, rain24h: 24 };

export default async function fetchBccRainfall() {
  const params = new URLSearchParams({
    select: 'gauge,location_name,measured,value,geopoint',
    where: 'sensor_type="Rainfall" and measured >= now(hours=-25)',
    order_by: 'measured',
  });
  const rows = await getJson(`${EXPORT}?${params}`, { timeoutMs: 60_000 });

  // Totals are anchored to the newest reading in the feed, so an hour-late publish doesn't zero them.
  const latest = Math.max(...rows.map((r) => Date.parse(r.measured)));
  const gauges = new Map();
  for (const r of rows) {
    if (!r.geopoint) continue;
    let g = gauges.get(r.gauge);
    if (!g) {
      g = { id: r.gauge, name: r.location_name, lon: r.geopoint.lon, lat: r.geopoint.lat, lastReport: null, rain1h: 0, rain3h: 0, rain24h: 0 };
      gauges.set(r.gauge, g);
    }
    if (r.value === null) continue;
    const t = Date.parse(r.measured);
    g.lastReport = Math.max(g.lastReport ?? 0, t);
    for (const [key, hours] of Object.entries(WINDOWS)) {
      if (t > latest - hours * 3600_000) g[key] += r.value;
    }
  }

  const round1 = (n) => Math.round(n * 10) / 10;
  const features = [...gauges.values()].map((g) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
    properties: {
      id: g.id,
      name: g.name,
      rain1h: round1(g.rain1h),
      rain3h: round1(g.rain3h),
      rain24h: round1(g.rain24h),
      // A gauge that hasn't reported in the window has unknown (not zero) rain.
      reporting: g.lastReport !== null,
      lastReport: g.lastReport ? Math.floor(g.lastReport / 1000) : null,
    },
  }));

  await writeJson('latest/bcc-rainfall.json', {
    type: 'FeatureCollection',
    asOf: Number.isFinite(latest) ? Math.floor(latest / 1000) : null,
    features,
  });
  return { count: features.length, reporting: features.filter((f) => f.properties.reporting).length };
}
