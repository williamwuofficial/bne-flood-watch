// Runs every fetcher. One failing source never blocks the others: its error is recorded in
// status.json and the previous snapshot (restored from the `data` branch) stays in place.
import { readJson, writeJson } from './lib.mjs';
import fetchBccGauges from './bcc-gauges.mjs';
import fetchBccRainfall from './bcc-rainfall.mjs';
import fetchTraffic from './traffic.mjs';

const FETCHERS = {
  'bcc-gauges': fetchBccGauges,
  'bcc-rainfall': fetchBccRainfall,
  traffic: fetchTraffic,
};

const status = await readJson('status.json', { sources: {} });
let failures = 0;

for (const [name, run] of Object.entries(FETCHERS)) {
  const started = Date.now();
  const entry = status.sources[name] ?? {};
  try {
    const info = await run();
    Object.assign(entry, { ok: true, lastSuccess: new Date().toISOString(), error: null, info });
    console.log(`✓ ${name} ${JSON.stringify(info)} (${Date.now() - started} ms)`);
  } catch (err) {
    failures++;
    Object.assign(entry, { ok: false, lastAttempt: new Date().toISOString(), error: String(err?.message ?? err) });
    console.error(`✗ ${name}: ${entry.error}`);
  }
  status.sources[name] = entry;
}

status.generated = new Date().toISOString();
await writeJson('status.json', status);

// Only fail the workflow if everything failed; partial data is still worth deploying.
if (failures === Object.keys(FETCHERS).length) process.exit(1);
