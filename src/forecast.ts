import { esc, fetchJson, fmtTime } from './util';

// Open-Meteo: free, keyless, CORS-enabled. "best_match" blends models, including BoM ACCESS for Australia.
interface OpenMeteo {
  current: { time: string; temperature_2m: number; precipitation: number; wind_gusts_10m: number; weather_code: number };
  hourly: { time: string[]; precipitation: number[]; precipitation_probability: number[]; wind_gusts_10m: number[] };
  daily: { time: string[]; precipitation_sum: number[]; precipitation_probability_max: number[] };
}

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  80: 'Showers', 81: 'Heavy showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

export async function renderForecast(el: HTMLElement, lat: number, lon: number) {
  el.textContent = 'Loading…';
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: 'temperature_2m,precipitation,wind_gusts_10m,weather_code',
    hourly: 'precipitation,precipitation_probability,wind_gusts_10m',
    daily: 'precipitation_sum,precipitation_probability_max',
    timezone: 'Australia/Brisbane',
    forecast_hours: '24',
    forecast_days: '3',
  });
  try {
    const d = await fetchJson<OpenMeteo>(`https://api.open-meteo.com/v1/forecast?${params}`);
    const total24 = d.hourly.precipitation.reduce((a, b) => a + b, 0);
    const maxGust = Math.max(...d.hourly.wind_gusts_10m);
    const maxRain = Math.max(0.5, ...d.hourly.precipitation);
    const bars = d.hourly.time
      .map((t, i) => {
        const mm = d.hourly.precipitation[i];
        const pct = d.hourly.precipitation_probability[i];
        const h = Math.round((mm / maxRain) * 100);
        const label = `${fmtTime(new Date(t + '+10:00'), { hour: 'numeric' })}: ${mm.toFixed(1)} mm, ${pct}% chance`;
        return `<div class="bar" style="--h:${h}%;--p:${pct / 100}" title="${esc(label)}"></div>`;
      })
      .join('');
    const days = d.daily.time
      .map((t, i) => {
        const name = i === 0 ? 'Today' : new Date(t + 'T12:00:00+10:00').toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'Australia/Brisbane' });
        return `<li><span>${name}</span><span>${d.daily.precipitation_sum[i].toFixed(1)} mm</span><span class="muted">${d.daily.precipitation_probability_max[i]}%</span></li>`;
      })
      .join('');
    el.innerHTML = `
      <div class="now">
        <span class="big">${Math.round(d.current.temperature_2m)}°</span>
        <span>${esc(WMO[d.current.weather_code] ?? '—')}</span>
      </div>
      <dl class="stats">
        <div><dt>Next 24 h rain</dt><dd>${total24.toFixed(1)} mm</dd></div>
        <div><dt>Max gust</dt><dd>${Math.round(maxGust)} km/h</dd></div>
      </dl>
      <div class="bars" aria-label="Hourly rain for the next 24 hours">${bars}</div>
      <div class="bars-axis"><span>now</span><span>+12 h</span><span>+24 h</span></div>
      <ul class="days">${days}</ul>`;
  } catch (err) {
    el.innerHTML = `<p class="error">Forecast unavailable (${esc((err as Error).message)}).</p>`;
  }
}
