// One-off (re-run only when the source dataset changes): download Brisbane City Council's
// February 2022 historic flood extent (~28 MB GeoJSON), simplify it with mapshaper, and save a
// small copy in public/static/ that is committed and served from GitHub Pages.
// Source: https://data.brisbane.qld.gov.au/explore/dataset/flood-awareness-historic-brisbane-river-and-creek-floods-feb-2022/ (CC BY 4.0)
import { execFileSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../fetchers/lib.mjs';

const CACHE = join(ROOT, '.cache');
const OUT = join(ROOT, 'public', 'static', 'flood-2022-feb.geojson');
const SRC_URL =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/flood-awareness-historic-brisbane-river-and-creek-floods-feb-2022/exports/geojson';

await mkdir(CACHE, { recursive: true });
const raw = join(CACHE, 'flood-2022-feb.raw.geojson');
try {
  await stat(raw);
} catch {
  console.log('Downloading BCC Feb 2022 flood extent…');
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`${res.status} downloading ${SRC_URL}`);
  await writeFile(raw, Buffer.from(await res.arrayBuffer()));
}

execFileSync(
  join(ROOT, 'node_modules', '.bin', 'mapshaper'),
  [
    raw,
    '-filter-fields', 'flood_event',
    '-dissolve', 'flood_event',
    '-simplify', 'dp', '8%', 'keep-shapes',
    '-filter-slivers', 'min-area=500m2',
    '-o', OUT, 'precision=0.00001', 'format=geojson',
  ],
  { stdio: 'inherit' },
);
console.log(`Wrote ${OUT} (${((await stat(OUT)).size / 1024).toFixed(0)} KB)`);
