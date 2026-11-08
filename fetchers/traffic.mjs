// QLDTraffic road events (flooding, hazards, crashes, roadworks), clipped to Greater Brisbane.
// Spec: https://qldtraffic.qld.gov.au/more/Developers-and-Data — data is CC BY 4.0 AU (State of Queensland, TMR).
// The public key below is the shared key published in the spec (globally limited to 100 req/min).
// Set QLDTRAFFIC_API_KEY in repo secrets if you register your own.
import { getJson, inBbox, positions, roundGeometry, writeJson } from './lib.mjs';

const PUBLIC_KEY = '3e83add325cbb69ac4d8e5bf433d770b';

export default async function fetchTraffic() {
  const key = process.env.QLDTRAFFIC_API_KEY || PUBLIC_KEY;
  const raw = await getJson(`https://api.qldtraffic.qld.gov.au/v2/events?apikey=${key}`);

  const features = raw.features
    .filter((f) => positions(f.geometry).some((p) => inBbox(p)))
    .map((f) => {
      const p = f.properties;
      return {
        type: 'Feature',
        id: p.id,
        geometry: roundGeometry(f.geometry),
        properties: {
          id: p.id,
          type: p.event_type,
          subtype: p.event_subtype,
          priority: p.event_priority,
          impact: p.impact?.impact_subtype ?? p.impact?.impact_type ?? null,
          road: p.road_summary?.road_name ?? null,
          locality: p.road_summary?.locality ?? null,
          description: p.description ?? null,
          advice: p.advice ?? null,
          updated: p.last_updated ?? null,
        },
      };
    });

  await writeJson('latest/traffic.json', { type: 'FeatureCollection', features });
  return { count: features.length };
}
