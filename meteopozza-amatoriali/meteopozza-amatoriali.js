/*
 * PozzaLive - stazioni amatoriali di Pozza di Fassa
 *
 * Endpoint:
 *   GET /          snapshot normalizzato delle due stazioni
 *   GET /stations  alias dello snapshot
 *   GET /health    descrizione del servizio, senza chiamate esterne
 *
 * Il browser interroga soltanto questo Worker. WeatherCloud e Netatmo
 * rimangono sorgenti server-side, con timeout, cache e fallback indipendenti.
 */

const SERVICE_NAME = "meteopozza-amatoriali";
const SCHEMA_VERSION = "1.0";

const WEATHERCLOUD_ID = "9435079591";
const WEATHERCLOUD_PAGE = `https://app.weathercloud.net/d${WEATHERCLOUD_ID}`;
const WEATHERCLOUD_VALUES = `https://app.weathercloud.net/device/values/${WEATHERCLOUD_ID}`;

const NETATMO_ID = "70:ee:50:17:9e:ba";
const NETATMO_TOKEN_URL = "https://auth.netatmo.com/weathermap/token";
const NETATMO_DATA_URL = "https://app.netatmo.net/api/getpublicmeasures";
const NETATMO_MAP_URL =
  "https://weathermap.netatmo.com/?stationid=70:ee:50:17:9e:ba&zoom=14.9";

// Riquadro ristretto alla Val di Fassa: evita la ricerca molto ampia del
// Worker LagunaLive e permette di individuare con precisione l'ID richiesto.
const NETATMO_BBOX = {
  latSW: 46.38,
  lonSW: 11.58,
  latNE: 46.52,
  lonNE: 11.86
};

const UPSTREAM_TIMEOUT_MS = 12_000;
const FRESH_CACHE_SECONDS = 3 * 60;
const CACHE_RETENTION_SECONDS = 6 * 60 * 60;
const RETRY_AFTER_ERROR_SECONDS = 5 * 60;
const STALE_AFTER_MINUTES = 30;

const STATION_DEFINITIONS = [
  {
    id: "pozza-cep",
    name: "Pozza – CEP",
    source: "WeatherCloud",
    sourceUrl: WEATHERCLOUD_PAGE
  },
  {
    id: "pozza-netatmo",
    name: "Pozza – Netatmo",
    source: "Netatmo",
    sourceUrl: NETATMO_MAP_URL
  }
];

function corsHeaders(cacheControl = "no-store") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl
  };
}

function jsonResponse(body, status = 200, cacheControl = "no-store") {
  return Response.json(body, {
    status,
    headers: corsHeaders(cacheControl)
  });
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function epochMilliseconds(value) {
  const epoch = numeric(value);
  if (epoch === null) return null;
  return epoch > 1_000_000_000_000 ? epoch : epoch * 1000;
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return null;
  return Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
}

function stationStatus(age, hasCoreData) {
  if (!hasCoreData) return "offline";
  return age === null || age > STALE_AFTER_MINUTES ? "stale" : "online";
}

function calculateDewPoint(temperature, humidity) {
  if (temperature === null || humidity === null || humidity <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(humidity / 100) + (a * temperature) / (b + temperature);
  return round((b * gamma) / (a - gamma));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timeout dopo ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const { text } = await fetchWithTimeout(url, options, timeoutMs);
  if (!text) throw new Error("Risposta vuota");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Risposta JSON non valida");
  }
}

function parseWeatherCloudMetadata(html) {
  const nameMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
  const name = nameMatch
    ? nameMatch[1].replace(/\s*-\s*Weathercloud\s*$/i, "").trim()
    : null;
  const altitudeMatch = html.match(/id="profile-altitude"[^>]*>\s*<strong>([^<]*)<\/strong>/i);
  const sourceAltitude = altitudeMatch
    ? numeric(altitudeMatch[1].replace(/[^\d,.-]/g, ""))
    : null;
  return { name, sourceAltitude };
}

function weatherCloudWindKmh(value) {
  const speed = numeric(value);
  return speed === null ? null : round(speed * 3.6);
}

async function fetchWeatherCloudStation() {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; PozzaLive/1.0; +https://andreavio00.github.io/meteo-fassa/)",
    "Accept": "application/json, text/plain, */*",
    "Referer": WEATHERCLOUD_PAGE,
    "X-Requested-With": "XMLHttpRequest"
  };

  const [metadataResult, values] = await Promise.all([
    fetchWithTimeout(WEATHERCLOUD_PAGE, {
      headers: { "User-Agent": headers["User-Agent"], "Accept": "text/html" }
    }).then(result => parseWeatherCloudMetadata(result.text)).catch(() => ({
      name: null,
      sourceAltitude: null
    })),
    fetchJson(WEATHERCLOUD_VALUES, { headers })
  ]);

  const updatedAt = epochMilliseconds(values.epoch);
  const age = ageMinutes(updatedAt);
  const temperature = numeric(values.temp);
  const humidity = numeric(values.hum);
  const pressure = numeric(values.bar);
  const hasCoreData = temperature !== null || humidity !== null || pressure !== null;

  if (!hasCoreData) throw new Error("WeatherCloud non ha restituito i dati principali");

  return {
    id: "pozza-cep",
    upstreamId: WEATHERCLOUD_ID,
    name: "Pozza – CEP",
    sourceName: metadataResult.name || "Stazione CEP",
    source: "WeatherCloud",
    sourceUrl: WEATHERCLOUD_PAGE,
    type: "amatoriale",
    notice: "Stazione amatoriale · dati non ufficiali",
    status: stationStatus(age, hasCoreData),
    stale: age === null || age > STALE_AFTER_MINUTES,
    fetchedAt: new Date().toISOString(),
    updatedAt,
    updatedAtIso: updatedAt ? new Date(updatedAt).toISOString() : null,
    ageMinutes: age,
    latitude: 46.426389,
    longitude: 11.685833,
    altitude: null,
    temperature,
    humidity,
    dewPoint: numeric(values.dew) ?? calculateDewPoint(temperature, humidity),
    windChill: numeric(values.chill),
    heatIndex: numeric(values.heat),
    thw: numeric(values.thw),
    pressure,
    wind: weatherCloudWindKmh(values.wspdavg ?? values.wspd),
    windInstant: weatherCloudWindKmh(values.wspd),
    windGust: weatherCloudWindKmh(values.wspdhi),
    windDirection: numeric(values.wdiravg ?? values.wdir),
    windDirectionInstant: numeric(values.wdir),
    rainRate: numeric(values.rainrate),
    rainToday: numeric(values.rain),
    rainHour: null,
    solarRadiation: numeric(values.solarrad),
    uvIndex: numeric(values.uvi),
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: pressure !== null,
      rain: values.rain !== null && values.rain !== undefined,
      wind: values.wspd !== null && values.wspd !== undefined,
      solar: values.solarrad !== null && values.solarrad !== undefined,
      uv: values.uvi !== null && values.uvi !== undefined
    },
    warnings: metadataResult.sourceAltitude !== null && metadataResult.sourceAltitude < 900
      ? [`Quota WeatherCloud non utilizzata (${metadataResult.sourceAltitude} m non compatibili con Pozza di Fassa).`]
      : []
  };
}

function findModuleId(moduleTypes, wantedType) {
  const found = Object.entries(moduleTypes || {}).find(([, type]) => type === wantedType);
  return found ? found[0] : null;
}

function latestValues(measure) {
  if (!measure?.res) return { epoch: null, values: {} };
  const entries = Object.entries(measure.res)
    .sort(([first], [second]) => Number(second) - Number(first));
  if (!entries.length) return { epoch: null, values: {} };
  const [epochText, rawValues] = entries[0];
  const values = {};
  (Array.isArray(measure.type) ? measure.type : []).forEach((type, index) => {
    values[type] = rawValues?.[index] ?? null;
  });
  return { epoch: numeric(epochText), values };
}

function safePozzaAltitude(value) {
  const altitude = numeric(value);
  return altitude !== null && altitude >= 900 && altitude <= 2500 ? altitude : null;
}

async function fetchNetatmoStation() {
  const tokenPayload = await fetchJson(NETATMO_TOKEN_URL, {
    headers: { "Accept": "application/json" }
  });
  const token = tokenPayload?.body;
  if (!token || typeof token !== "string") {
    throw new Error("Netatmo non ha restituito il token pubblico");
  }

  const params = new URLSearchParams({
    zoom: "12",
    lat_ne: String(NETATMO_BBOX.latNE),
    lon_ne: String(NETATMO_BBOX.lonNE),
    lat_sw: String(NETATMO_BBOX.latSW),
    lon_sw: String(NETATMO_BBOX.lonSW),
    date_end: "last",
    limit: "100",
    divider: "1",
    quality: "1",
    access_token: token
  });

  const payload = await fetchJson(`${NETATMO_DATA_URL}?${params}`, {
    headers: { "Accept": "application/json" }
  }, 20_000);
  if (payload?.error) {
    throw new Error(payload.error.message || "Errore Netatmo");
  }

  const rawStations = Array.isArray(payload?.body) ? payload.body : [];
  const station = rawStations.find(item =>
    String(item?._id || "").toLowerCase() === NETATMO_ID
  );
  if (!station) {
    throw new Error("Stazione Netatmo non trovata nel riquadro di Pozza");
  }

  const place = station.place || {};
  const measures = station.measures || {};
  const moduleTypes = station.module_types || {};
  const outdoorId = findModuleId(moduleTypes, "NAModule1");
  const windId = findModuleId(moduleTypes, "NAModule2");
  const rainId = findModuleId(moduleTypes, "NAModule3");
  const outdoor = latestValues(outdoorId ? measures[outdoorId] : null);
  const main = latestValues(measures[station._id]);
  const wind = windId ? measures[windId] || null : null;
  const rain = rainId ? measures[rainId] || null : null;

  const temperature = numeric(outdoor.values.temperature);
  const humidity = numeric(outdoor.values.humidity);
  const pressure = numeric(main.values.pressure);
  const epochs = [
    outdoor.epoch,
    main.epoch,
    numeric(wind?.wind_timeutc),
    numeric(rain?.rain_timeutc)
  ].filter(value => value !== null);
  const updatedAt = epochs.length ? Math.max(...epochs) * 1000 : null;
  const age = ageMinutes(updatedAt);
  const hasCoreData = temperature !== null || humidity !== null || pressure !== null;
  if (!hasCoreData) throw new Error("Netatmo non ha restituito i dati principali");

  const coordinates = Array.isArray(place.location) ? place.location : [];
  const sourceAltitude = numeric(place.altitude);
  const altitude = safePozzaAltitude(sourceAltitude);

  return {
    id: "pozza-netatmo",
    upstreamId: NETATMO_ID,
    name: "Pozza – Netatmo",
    sourceName: place.city ? `Netatmo · ${place.city}` : "Stazione Netatmo",
    source: "Netatmo",
    sourceUrl: NETATMO_MAP_URL,
    type: "amatoriale",
    notice: "Stazione amatoriale · dati non ufficiali",
    status: stationStatus(age, hasCoreData),
    stale: age === null || age > STALE_AFTER_MINUTES,
    fetchedAt: new Date().toISOString(),
    updatedAt,
    updatedAtIso: updatedAt ? new Date(updatedAt).toISOString() : null,
    ageMinutes: age,
    latitude: numeric(coordinates[1]),
    longitude: numeric(coordinates[0]),
    altitude,
    temperature,
    humidity,
    dewPoint: calculateDewPoint(temperature, humidity),
    windChill: null,
    heatIndex: null,
    thw: null,
    pressure,
    wind: numeric(wind?.wind_strength),
    windInstant: numeric(wind?.wind_strength),
    windGust: numeric(wind?.gust_strength),
    windDirection: numeric(wind?.wind_angle),
    windDirectionInstant: numeric(wind?.wind_angle),
    rainRate: numeric(rain?.rain_live),
    rainToday: numeric(rain?.rain_24h),
    rainHour: numeric(rain?.rain_60min),
    solarRadiation: null,
    uvIndex: null,
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: pressure !== null,
      rain: Boolean(rainId),
      wind: Boolean(windId),
      solar: false,
      uv: false
    },
    warnings: sourceAltitude !== null && altitude === null
      ? [`Quota Netatmo non utilizzata (${sourceAltitude} m non compatibili con Pozza di Fassa).`]
      : []
  };
}

function offlineStation(index, error) {
  const definition = STATION_DEFINITIONS[index];
  return {
    ...definition,
    type: "amatoriale",
    notice: "Stazione amatoriale · dati non ufficiali",
    status: "offline",
    stale: true,
    fetchedAt: new Date().toISOString(),
    updatedAt: null,
    updatedAtIso: null,
    ageMinutes: null,
    temperature: null,
    humidity: null,
    pressure: null,
    error: error?.message || "Dati temporaneamente non disponibili"
  };
}

function staleStation(previous, error) {
  return {
    ...previous,
    status: "stale",
    stale: true,
    error: error?.message || "Aggiornamento temporaneamente non disponibile"
  };
}

async function refreshSnapshot(previous = null) {
  const operations = [fetchWeatherCloudStation(), fetchNetatmoStation()];
  const settled = await Promise.allSettled(operations);
  const previousById = new Map(
    (Array.isArray(previous?.stations) ? previous.stations : [])
      .map(station => [station.id, station])
  );

  const stations = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const definition = STATION_DEFINITIONS[index];
    const cached = previousById.get(definition.id);
    return cached ? staleStation(cached, result.reason) : offlineStation(index, result.reason);
  });

  const generatedAt = new Date().toISOString();
  const online = stations.filter(station => station.status === "online").length;
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    service: SERVICE_NAME,
    generatedAt,
    fetchedAt: online ? generatedAt : previous?.fetchedAt || generatedAt,
    lastRefreshAttemptAt: generatedAt,
    partial: stations.some(station => station.status !== "online"),
    count: stations.length,
    online,
    stations,
    sources: stations.map(station => ({
      id: station.id,
      source: station.source,
      status: station.status,
      error: station.error || null
    }))
  };
}

function snapshotAge(snapshot) {
  const timestamp = Date.parse(snapshot?.fetchedAt || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function attemptAge(snapshot) {
  const timestamp = Date.parse(snapshot?.lastRefreshAttemptAt || snapshot?.fetchedAt || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

async function storeSnapshot(cache, cacheKey, snapshot, context) {
  if (!cache) return;
  const operation = cache.put(cacheKey, new Response(JSON.stringify(snapshot), {
    headers: corsHeaders(`public, max-age=${CACHE_RETENTION_SECONDS}`)
  }));
  if (typeof context?.waitUntil === "function") context.waitUntil(operation);
  else await operation;
}

async function getSnapshot(request, context) {
  const cache = globalThis.caches?.default || null;
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(
    `${requestUrl.origin}/__cache/meteopozza-amatoriali-v1`,
    { method: "GET" }
  );
  let cached = null;

  if (cache) {
    const response = await cache.match(cacheKey);
    if (response) {
      try { cached = await response.json(); } catch { cached = null; }
    }
  }

  if (cached && snapshotAge(cached) <= FRESH_CACHE_SECONDS * 1000) {
    return { ...cached, cache: "HIT" };
  }

  const previousHadErrors = cached?.stations?.some(station => station.error);
  if (cached && previousHadErrors && attemptAge(cached) <= RETRY_AFTER_ERROR_SECONDS * 1000) {
    return { ...cached, cache: "STALE" };
  }

  const snapshot = await refreshSnapshot(cached);
  await storeSnapshot(cache, cacheKey, snapshot, context);
  return { ...snapshot, cache: cached ? "REFRESH" : "MISS" };
}

function healthPayload() {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    service: SERVICE_NAME,
    generatedAt: new Date().toISOString(),
    stations: STATION_DEFINITIONS,
    endpoints: ["/", "/stations", "/health"],
    cacheSeconds: FRESH_CACHE_SECONDS
  };
}

export default {
  async fetch(request, env = {}, context = {}) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Metodo non consentito" }, 405);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") return jsonResponse(healthPayload(), 200, "public, max-age=60");
    if (path !== "/" && path !== "/stations") {
      return jsonResponse({ ok: false, error: "Endpoint non trovato" }, 404);
    }

    try {
      const snapshot = await getSnapshot(request, context);
      return jsonResponse(
        snapshot,
        200,
        `public, max-age=${FRESH_CACHE_SECONDS}, stale-while-revalidate=${RETRY_AFTER_ERROR_SECONDS}`
      );
    } catch (error) {
      return jsonResponse({
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        service: SERVICE_NAME,
        generatedAt: new Date().toISOString(),
        error: error?.message || "Errore interno del servizio"
      }, 502);
    }
  }
};
