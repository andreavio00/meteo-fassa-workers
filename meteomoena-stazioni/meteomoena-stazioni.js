/*
 * MoenaLive - stazioni principali
 *
 * Fonti server-side, raggiunte tramite Service Bindings:
 *   TRENTINO -> gite-meteotrentino (T0096, Diga di Pezze)
 *   POZZA    -> meteopozza-stazioni (Strada de Even e MeteoNetwork Pezzè)
 *
 * Endpoint:
 *   GET /          snapshot normalizzato
 *   GET /stations  alias dello snapshot
 *   GET /health    configurazione, senza chiamate alle fonti
 */

const SERVICE_NAME = "meteomoena-stazioni";
const SCHEMA_VERSION = "1.1";

const UPSTREAM_TIMEOUT_MS = 8_000;
const FRESH_CACHE_SECONDS = 2 * 60;
const CACHE_RETENTION_SECONDS = 6 * 60 * 60;
const RETRY_AFTER_ERROR_SECONDS = 5 * 60;
const STALE_AFTER_MINUTES = 30;

const METEOTRENTINO_SOURCE_URL =
  "https://www.meteotrentino.it/dati/meteo/ultimi-dati-meteo/";
const MOENA_METEO_SOURCE_URL = "https://www.moenameteo.it/";
const PEZZE_SOURCE_URL =
  "https://www.meteonetwork.eu/it/weather-station/trn352-stazione-meteorologica-di-frazione-pezze";

const UNITS = {
  temperature: "°C",
  pressure: "hPa",
  wind: "km/h",
  rain: "mm",
  solarRadiation: "W/m²"
};

const STATION_DEFINITIONS = [
  {
    id: "moena-diga-pezze",
    upstreamId: "T0096",
    name: "Diga di Pezzè",
    fullName: "Moena - Diga di Pezzè",
    category: "official",
    source: "MeteoTrentino",
    sourceName: "MeteoTrentino",
    sourceUrl: METEOTRENTINO_SOURCE_URL,
    notice: "Stazione ufficiale"
  },
  {
    id: "moena-meteo",
    upstreamId: "moena",
    name: "Strada de Even",
    fullName: "Moena - Strada de Even",
    category: "reference",
    source: "Moena Meteo",
    sourceName: "Moena Meteo",
    sourceUrl: MOENA_METEO_SOURCE_URL,
    notice: "Stazione Helium2"
  },
  {
    id: "moena-pezze-meteonetwork",
    upstreamId: "TRN352",
    name: "Frazione Pezzè",
    fullName: "Moena - Frazione Pezzè",
    category: "reference",
    source: "MeteoNetwork",
    sourceName: "MeteoNetwork TRN352",
    sourceUrl: PEZZE_SOURCE_URL,
    notice: "Stazione a norma MeteoNetwork"
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
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function bounded(value, minimum, maximum) {
  const number = numeric(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return null;
  return Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
}

function stationStatus(age, hasCoreData, upstreamState = "ok") {
  if (!hasCoreData) return "offline";
  if (upstreamState === "stale" || age === null || age > STALE_AFTER_MINUTES) {
    return "stale";
  }
  return "online";
}

function directionFromDegrees(value) {
  const degrees = bounded(value, 0, 360);
  if (degrees === null) return null;
  const directions = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
  ];
  return directions[Math.round(degrees / 22.5) % 16];
}

function calculateDewPoint(temperature, humidity) {
  if (temperature === null || humidity === null || humidity <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(humidity / 100) + (a * temperature) / (b + temperature);
  return round((b * gamma) / (a - gamma));
}

function emptyModules() {
  return {
    temperature: false,
    humidity: false,
    pressure: false,
    rain: false,
    wind: false,
    solar: false,
    uv: false
  };
}

function stationBase(definition) {
  return {
    ...definition,
    status: "offline",
    stale: true,
    fetchedAt: new Date().toISOString(),
    updatedAt: null,
    updatedAtIso: null,
    ageMinutes: null,
    latitude: null,
    longitude: null,
    altitude: null,
    coordinatesApproximate: false,
    temperature: null,
    temperatureMin: null,
    temperatureMax: null,
    humidity: null,
    dewPoint: null,
    windChill: null,
    heatIndex: null,
    pressure: null,
    wind: null,
    windGust: null,
    windDirection: null,
    windDirectionText: null,
    rainRate: null,
    rainHour: null,
    rainToday: null,
    solarRadiation: null,
    uvIndex: null,
    modules: emptyModules(),
    warnings: [],
    error: null
  };
}

function finalizeStation(definition, values) {
  const updatedAt = timestampMilliseconds(values.updatedAt);
  const age = ageMinutes(updatedAt);
  const hasCoreData =
    values.temperature !== null ||
    values.humidity !== null ||
    values.pressure !== null ||
    values.rainToday !== null;
  const status = stationStatus(age, hasCoreData, values.upstreamState);
  const { upstreamState, ...publicValues } = values;

  return {
    ...stationBase(definition),
    ...publicValues,
    status,
    stale: status !== "online",
    fetchedAt: new Date().toISOString(),
    updatedAt,
    updatedAtIso: updatedAt ? new Date(updatedAt).toISOString() : null,
    ageMinutes: age,
    error: publicValues.error || null
  };
}

function normalizeTrentino(raw) {
  const definition = STATION_DEFINITIONS[0];
  if (!raw || raw.status === "error") {
    throw new Error(raw?.error || "Diga di Pezze non disponibile");
  }

  const temperature = bounded(raw.temperature, -60, 60);
  const humidity = bounded(raw.humidity, 0, 100);
  const windMs = bounded(raw.wind, 0, 100);
  const gustMs = bounded(raw.windGust, 0, 150);
  const windDirection = bounded(raw.windDirectionDegrees, 0, 360);

  return finalizeStation(definition, {
    latitude: bounded(raw.latitude, -90, 90),
    longitude: bounded(raw.longitude, -180, 180),
    altitude: bounded(raw.altitude, 0, 5000),
    coordinatesApproximate: false,
    temperature,
    temperatureMin: bounded(raw.temperatureMin, -60, 60),
    temperatureMax: bounded(raw.temperatureMax, -60, 60),
    humidity,
    dewPoint: calculateDewPoint(temperature, humidity),
    windChill: null,
    heatIndex: null,
    pressure: bounded(raw.pressure, 700, 1150),
    wind: windMs === null ? null : round(windMs * 3.6),
    windGust: gustMs === null ? null : round(gustMs * 3.6),
    windDirection,
    windDirectionText: raw.windDirection || directionFromDegrees(windDirection),
    rainRate: null,
    rainHour: null,
    rainToday: bounded(raw.precipitation, 0, 2000),
    solarRadiation: bounded(raw.solarRadiation, 0, 2000),
    uvIndex: null,
    updatedAt: raw.updated || raw.temperatureAt,
    upstreamState: raw.status === "online" ? "ok" : "stale",
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: bounded(raw.pressure, 700, 1150) !== null,
      rain: bounded(raw.precipitation, 0, 2000) !== null,
      wind: windMs !== null,
      solar: bounded(raw.solarRadiation, 0, 2000) !== null,
      uv: false
    },
    warnings: []
  });
}

function normalizeMoenaMeteo(raw) {
  const definition = STATION_DEFINITIONS[1];
  if (!raw) throw new Error("Moena Meteo non disponibile");

  const warnings = [
    "Posizione indicativa lungo Strada de Even: la sorgente non pubblica le coordinate esatte."
  ];
  const rawMinimum = numeric(raw.temperatura_min);
  const rawMaximum = numeric(raw.temperatura_max);
  const temperatureMin = bounded(raw.temperatura_min, -60, 60);
  const temperatureMax = bounded(raw.temperatura_max, -60, 60);
  if ((rawMinimum !== null && temperatureMin === null) ||
      (rawMaximum !== null && temperatureMax === null)) {
    warnings.push("Minima e massima non utilizzate: valori non plausibili restituiti dalla sorgente.");
  }

  const temperature = bounded(raw.temperatura, -60, 60);
  const humidity = bounded(raw.umidita, 0, 100);
  const pressure = bounded(raw.pressione, 700, 1150);
  const wind = bounded(raw.vento, 0, 300);
  const windGust = bounded(raw.vento_max_giorno, 0, 350);

  return finalizeStation(definition, {
    latitude: 46.3803,
    longitude: 11.6568,
    altitude: bounded(raw.quota, 0, 5000),
    coordinatesApproximate: true,
    temperature,
    temperatureMin,
    temperatureMax,
    humidity,
    dewPoint: bounded(raw.dew_point, -80, 60) ?? calculateDewPoint(temperature, humidity),
    windChill: bounded(raw.wind_chill, -80, 60),
    heatIndex: bounded(raw.heat_index, -60, 80),
    pressure,
    wind,
    windGust,
    windDirection: null,
    windDirectionText: raw.direzione || null,
    rainRate: bounded(raw.pioggia_rate, 0, 1000),
    rainHour: null,
    rainToday: bounded(raw.pioggia, 0, 2000),
    solarRadiation: null,
    uvIndex: null,
    updatedAt: raw.aggiornamento,
    upstreamState: raw.stato === "stale" ? "stale" : "ok",
    error: raw.erroreRete || null,
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: pressure !== null,
      rain: raw.pioggia !== null && raw.pioggia !== undefined,
      wind: raw.vento !== null && raw.vento !== undefined,
      solar: false,
      uv: false
    },
    warnings
  });
}

function normalizePezze(raw) {
  const definition = STATION_DEFINITIONS[2];
  if (!raw) throw new Error("Frazione Pezzè non disponibile");

  const temperature = bounded(raw.temperatura, -60, 60);
  const humidity = bounded(raw.umidita, 0, 100);
  const pressure = bounded(raw.pressione, 700, 1150);
  const wind = bounded(raw.vento, 0, 300);
  const windGust = bounded(raw.raffica, 0, 350);

  return finalizeStation(definition, {
    latitude: 46.38,
    longitude: 11.665,
    altitude: 1212,
    coordinatesApproximate: true,
    temperature,
    temperatureMin: bounded(raw.temperatura_min, -60, 60),
    temperatureMax: bounded(raw.temperatura_max, -60, 60),
    humidity,
    dewPoint: bounded(raw.dew_point, -80, 60) ?? calculateDewPoint(temperature, humidity),
    windChill: null,
    heatIndex: bounded(raw.heat_index, -60, 80),
    pressure,
    wind,
    windGust,
    windDirection: null,
    windDirectionText: raw.direzione || null,
    rainRate: bounded(raw.pioggia_rate, 0, 1000),
    rainHour: null,
    rainToday: bounded(raw.pioggia, 0, 2000),
    solarRadiation: bounded(raw.radiazione_solare, 0, 2000),
    uvIndex: bounded(raw.uv, 0, 30),
    updatedAt: raw.aggiornamento,
    upstreamState: raw.stato === "stale" ? "stale" : "ok",
    error: raw.erroreRete || null,
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: pressure !== null,
      rain: raw.pioggia !== null && raw.pioggia !== undefined,
      wind: raw.vento !== null && raw.vento !== undefined,
      solar: raw.radiazione_solare !== null && raw.radiazione_solare !== undefined,
      uv: raw.uv !== null && raw.uv !== undefined
    },
    warnings: ["Coordinate pubblicate dalla fonte con precisione limitata (46.38 N, 11.665 E)."]
  });
}

async function fetchBindingJson(binding, url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  if (!binding || typeof binding.fetch !== "function") {
    throw new Error("Service Binding non configurato");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await binding.fetch(new Request(url, {
      method: "GET",
      signal: controller.signal
    }));
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    if (!text) throw new Error("Risposta vuota");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Risposta JSON non valida");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timeout dopo ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function offlineStation(definition, error) {
  return {
    ...stationBase(definition),
    error: error?.message || String(error || "Dati temporaneamente non disponibili")
  };
}

function staleStation(previous, error) {
  return {
    ...previous,
    status: "stale",
    stale: true,
    error: error?.message || String(error || "Aggiornamento temporaneamente non disponibile")
  };
}

function resolvedStation(definition, normalizer, source, previousById) {
  try {
    return normalizer(source);
  } catch (error) {
    const previous = previousById.get(definition.id);
    return previous ? staleStation(previous, error) : offlineStation(definition, error);
  }
}

async function refreshSnapshot(env, previous = null) {
  const [trentinoResult, localResult] = await Promise.allSettled([
    fetchBindingJson(env?.TRENTINO, "https://gite-meteotrentino/?station=moena"),
    fetchBindingJson(env?.POZZA, "https://meteopozza-stazioni/")
  ]);

  const previousById = new Map(
    (Array.isArray(previous?.stations) ? previous.stations : [])
      .map(station => [station.id, station])
  );

  const trentinoSource = trentinoResult.status === "fulfilled"
    ? trentinoResult.value
    : null;
  const localSource = localResult.status === "fulfilled"
    ? localResult.value
    : null;

  const stations = [
    trentinoResult.status === "fulfilled"
      ? resolvedStation(STATION_DEFINITIONS[0], normalizeTrentino, trentinoSource, previousById)
      : (previousById.has(STATION_DEFINITIONS[0].id)
        ? staleStation(previousById.get(STATION_DEFINITIONS[0].id), trentinoResult.reason)
        : offlineStation(STATION_DEFINITIONS[0], trentinoResult.reason)),
    localResult.status === "fulfilled"
      ? resolvedStation(STATION_DEFINITIONS[1], normalizeMoenaMeteo, localSource?.moena, previousById)
      : (previousById.has(STATION_DEFINITIONS[1].id)
        ? staleStation(previousById.get(STATION_DEFINITIONS[1].id), localResult.reason)
        : offlineStation(STATION_DEFINITIONS[1], localResult.reason)),
    localResult.status === "fulfilled"
      ? resolvedStation(STATION_DEFINITIONS[2], normalizePezze, localSource?.pezze, previousById)
      : (previousById.has(STATION_DEFINITIONS[2].id)
        ? staleStation(previousById.get(STATION_DEFINITIONS[2].id), localResult.reason)
        : offlineStation(STATION_DEFINITIONS[2], localResult.reason))
  ];

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
    units: UNITS,
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

async function getSnapshot(request, env, context) {
  const cache = globalThis.caches?.default || null;
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(
    `${requestUrl.origin}/__cache/meteomoena-stazioni-v2`,
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

  const previousHadErrors = cached?.stations?.some(station => station.status !== "online");
  if (cached && previousHadErrors && attemptAge(cached) <= RETRY_AFTER_ERROR_SECONDS * 1000) {
    return { ...cached, cache: "STALE" };
  }

  const snapshot = await refreshSnapshot(env, cached);
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
    requiredBindings: ["TRENTINO", "POZZA"],
    endpoints: ["/", "/stations", "/health"],
    cacheSeconds: FRESH_CACHE_SECONDS,
    units: UNITS
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
    if (path === "/health") {
      return jsonResponse(healthPayload(), 200, "public, max-age=60");
    }
    if (path !== "/" && path !== "/stations") {
      return jsonResponse({ ok: false, error: "Endpoint non trovato" }, 404);
    }

    try {
      const snapshot = await getSnapshot(request, env, context);
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
