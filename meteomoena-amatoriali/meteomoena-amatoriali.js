/*
 * MoenaLive - stazioni amatoriali
 *
 * Weather Underground viene letto dalle pagine pubbliche delle tre PWS.
 * Netatmo viene letto con una sola richiesta pubblica per il riquadro di Moena.
 * Ogni stazione ha fallback e stato indipendenti nello snapshot finale.
 *
 * Endpoint:
 *   GET /          snapshot normalizzato delle sei stazioni
 *   GET /stations  alias dello snapshot
 *   GET /health    configurazione, senza chiamate esterne
 */

const SERVICE_NAME = "meteomoena-amatoriali";
const SCHEMA_VERSION = "1.0";

const NETATMO_TOKEN_URL = "https://auth.netatmo.com/weathermap/token";
const NETATMO_DATA_URL = "https://app.netatmo.net/api/getpublicmeasures";
const NETATMO_BBOX = {
  latSW: 46.35,
  lonSW: 11.62,
  latNE: 46.40,
  lonNE: 11.69
};

const UPSTREAM_TIMEOUT_MS = 12_000;
const FRESH_CACHE_SECONDS = 3 * 60;
const CACHE_RETENTION_SECONDS = 6 * 60 * 60;
const RETRY_AFTER_ERROR_SECONDS = 5 * 60;
const STALE_AFTER_MINUTES = 30;

const UNITS = {
  temperature: "°C",
  pressure: "hPa",
  wind: "km/h",
  rain: "mm",
  solarRadiation: "W/m²"
};

const STATION_DEFINITIONS = [
  {
    id: "moena-lenz",
    upstreamId: "IMOENA8",
    name: "Lenz",
    fullName: "Moena - Stazione Lenz",
    category: "amateur",
    source: "Weather Underground",
    sourceName: "Weather Underground - IMOENA8",
    sourceUrl: "https://www.wunderground.com/dashboard/pws/IMOENA8",
    provider: "wunderground",
    fallbackAltitude: 1210
  },
  {
    id: "moena-villa-iellici",
    upstreamId: "IMOENA7",
    name: "Villa Iellici",
    fullName: "Moena - Villa Iellici",
    category: "amateur",
    source: "Weather Underground",
    sourceName: "Weather Underground - IMOENA7",
    sourceUrl: "https://www.wunderground.com/dashboard/pws/IMOENA7",
    provider: "wunderground",
    fallbackAltitude: 1207
  },
  {
    id: "moena-ischiacia",
    upstreamId: "70:ee:50:01:b2:8a",
    name: "Ischiacia",
    fullName: "Moena - Strada de Ischiacia",
    category: "amateur",
    source: "Netatmo",
    sourceName: "Netatmo - Strada de Ischiacia",
    sourceUrl: "https://weathermap.netatmo.com/?stationid=70:ee:50:01:b2:8a&zoom=14.689552356472166",
    provider: "netatmo"
  },
  {
    id: "moena-wolf",
    upstreamId: "IMOENA6",
    name: "Wolf",
    fullName: "Moena - Wolf-Wetterstation",
    category: "amateur",
    source: "Weather Underground",
    sourceName: "Weather Underground - IMOENA6",
    sourceUrl: "https://www.wunderground.com/dashboard/pws/IMOENA6",
    provider: "wunderground",
    fallbackAltitude: 1190
  },
  {
    id: "moena-lowy",
    upstreamId: "70:ee:50:52:ed:76",
    name: "Löwy",
    fullName: "Moena - Strada Riccardo Löwy",
    category: "amateur",
    source: "Netatmo",
    sourceName: "Netatmo - Strada Riccardo Löwy",
    sourceUrl: "https://weathermap.netatmo.com/?stationid=70:ee:50:52:ed:76&zoom=14.9",
    provider: "netatmo"
  },
  {
    id: "moena-someda",
    upstreamId: "70:ee:50:90:90:e0",
    name: "Someda",
    fullName: "Moena - Strada de Someda",
    category: "amateur",
    source: "Netatmo",
    sourceName: "Netatmo - Strada de Someda",
    sourceUrl: "https://weathermap.netatmo.com/?stationid=70:ee:50:90:90:e0&zoom=14.9",
    provider: "netatmo"
  }
];

const WUNDERGROUND_STATIONS = STATION_DEFINITIONS.filter(
  station => station.provider === "wunderground"
);
const NETATMO_STATIONS = STATION_DEFINITIONS.filter(
  station => station.provider === "netatmo"
);

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

function epochMilliseconds(value) {
  const epoch = numeric(value);
  if (epoch !== null && /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    return epoch > 1_000_000_000_000 ? epoch : epoch * 1000;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return null;
  return Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
}

function stationStatus(age, hasCoreData, connected = true) {
  if (!hasCoreData) return "offline";
  return connected && age !== null && age <= STALE_AFTER_MINUTES
    ? "online"
    : "stale";
}

function calculateDewPoint(temperature, humidity) {
  if (temperature === null || humidity === null || humidity <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(humidity / 100) + (a * temperature) / (b + temperature);
  return round((b * gamma) / (a - gamma));
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

function publicDefinition(definition) {
  const { provider, fallbackAltitude, ...publicFields } = definition;
  return publicFields;
}

function stationBase(definition) {
  return {
    ...publicDefinition(definition),
    notice: "Stazione amatoriale - dati non ufficiali",
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
  const updatedAt = epochMilliseconds(values.updatedAt);
  const age = ageMinutes(updatedAt);
  const hasCoreData =
    values.temperature !== null ||
    values.humidity !== null ||
    values.pressure !== null;
  const status = stationStatus(age, hasCoreData, values.connected !== false);

  const { connected, ...publicValues } = values;
  return {
    ...stationBase(definition),
    ...publicValues,
    status,
    stale: status !== "online",
    fetchedAt: new Date().toISOString(),
    updatedAt,
    updatedAtIso: updatedAt ? new Date(updatedAt).toISOString() : null,
    ageMinutes: age,
    error: values.error || null
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&deg;/gi, "°")
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(html, tagName) {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, "i"))?.[0] || "";
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`${escaped}\\s*=\\s*[\"']([^\"']*)[\"']`, "i"))?.[1] ?? null;
}

function fahrenheitToCelsius(value) {
  const number = numeric(value);
  return number === null ? null : round((number - 32) * 5 / 9);
}

function milesToKilometres(value) {
  const number = numeric(value);
  return number === null ? null : round(number * 1.609344);
}

function inchesToMillimetres(value) {
  const number = numeric(value);
  return number === null ? null : round(number * 25.4);
}

function inchesMercuryToHpa(value) {
  const number = numeric(value);
  return number === null ? null : round(number * 33.8638866667);
}

function average(first, second) {
  const values = [numeric(first), numeric(second)]
    .filter(value => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/*
 * Weather Underground sta distribuendo due versioni del dashboard:
 *
 * - la pagina storica, con i custom element temp-widget-view ecc.;
 * - la nuova applicazione Angular, che incorpora nel tag app-root-state le
 *   osservazioni a cinque minuti e il riepilogo giornaliero.
 *
 * La seconda forma e' gia' attiva almeno per IMOENA6. La leggiamo come
 * fallback, senza usare nel codice una API key estratta dalla pagina.
 */
function parseWundergroundAppState(definition, html) {
  const stateMatch = html.match(
    /<script[^>]*id=["']app-root-state["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!stateMatch) {
    throw new Error(`Dati Weather Underground non trovati per ${definition.upstreamId}`);
  }

  let state;
  try {
    state = JSON.parse(stateMatch[1]);
  } catch {
    throw new Error(`Stato Weather Underground non valido per ${definition.upstreamId}`);
  }

  const observations = [];
  const summaries = [];
  for (const entry of Object.values(state || {})) {
    const body = entry?.b || entry?.value || null;
    if (Array.isArray(body?.observations)) observations.push(...body.observations);
    if (Array.isArray(body?.summaries)) summaries.push(...body.summaries);
  }

  const stationId = definition.upstreamId.toUpperCase();
  const matchingObservations = observations
    .filter(item => String(item?.stationID || "").toUpperCase() === stationId)
    .sort((first, second) => numeric(first?.epoch) - numeric(second?.epoch));
  const matchingSummaries = summaries
    .filter(item => String(item?.stationID || "").toUpperCase() === stationId)
    .sort((first, second) => numeric(first?.epoch) - numeric(second?.epoch));

  const observation = matchingObservations.at(-1) || null;
  const summary = matchingSummaries.at(-1) || null;
  if (!observation?.imperial) {
    throw new Error(`Osservazioni Weather Underground non trovate per ${definition.upstreamId}`);
  }

  const imperial = observation.imperial;
  const daily = summary?.imperial || {};
  const temperature = fahrenheitToCelsius(
    imperial.tempAvg ?? average(imperial.tempHigh, imperial.tempLow)
  );
  const humidity = bounded(
    observation.humidityAvg ?? average(observation.humidityHigh, observation.humidityLow),
    0,
    100
  );
  const pressureInHg = average(imperial.pressureMax, imperial.pressureMin);
  const windDirection = bounded(observation.winddirAvg, 0, 360);

  return finalizeStation(definition, {
    sourceName: definition.sourceName,
    latitude: bounded(observation.lat, -90, 90),
    longitude: bounded(observation.lon, -180, 180),
    altitude: bounded(definition.fallbackAltitude, 0, 5000),
    coordinatesApproximate: false,
    temperature,
    temperatureMin: fahrenheitToCelsius(daily.tempLow),
    temperatureMax: fahrenheitToCelsius(daily.tempHigh),
    humidity,
    dewPoint: fahrenheitToCelsius(
      imperial.dewptAvg ?? average(imperial.dewptHigh, imperial.dewptLow)
    ),
    windChill: fahrenheitToCelsius(
      imperial.windchillAvg ?? average(imperial.windchillHigh, imperial.windchillLow)
    ),
    heatIndex: fahrenheitToCelsius(
      imperial.heatindexAvg ?? average(imperial.heatindexHigh, imperial.heatindexLow)
    ),
    pressure: inchesMercuryToHpa(pressureInHg),
    wind: milesToKilometres(
      imperial.windspeedAvg ?? average(imperial.windspeedHigh, imperial.windspeedLow)
    ),
    windGust: milesToKilometres(imperial.windgustHigh ?? imperial.windgustAvg),
    windDirection,
    windDirectionText: directionFromDegrees(windDirection),
    rainRate: inchesToMillimetres(imperial.precipRate),
    rainHour: null,
    rainToday: inchesToMillimetres(daily.precipTotal ?? imperial.precipTotal),
    solarRadiation: bounded(observation.solarRadiationHigh, 0, 2000),
    uvIndex: bounded(observation.uvHigh, 0, 30),
    updatedAt: observation.obsTimeUtc || observation.epoch,
    connected: true,
    modules: {
      temperature: temperature !== null,
      humidity: humidity !== null,
      pressure: pressureInHg !== null,
      rain: imperial.precipRate !== null || daily.precipTotal !== null,
      wind: imperial.windspeedAvg !== null || imperial.windspeedHigh !== null,
      solar: observation.solarRadiationHigh !== null &&
        observation.solarRadiationHigh !== undefined,
      uv: observation.uvHigh !== null && observation.uvHigh !== undefined
    },
    warnings: ["Dati correnti ricavati dalla serie Weather Underground a 5 minuti."]
  });
}

function parseWunderground(definition, html) {
  const statusTag = firstTag(html, "pws-status");
  const temperatureTag = firstTag(html, "temp-widget-view");
  const humidityTag = firstTag(html, "humidity-widget-view");
  const windTag = firstTag(html, "wind-widget-view");
  const rainTag = firstTag(html, "rain-widget-view");
  const pressureTag = firstTag(html, "pressure-widget-view");
  const uvTag = firstTag(html, "uv-widget-view");
  const solarTag = firstTag(html, "solar-radiation-widget-view");
  const mapTag = firstTag(html, "wundermap-view");

  const unit = String(attribute(temperatureTag, "data-unit") || "e").toLowerCase();
  const imperial = unit === "e" || unit === "imperial";

  const temperatureRaw = attribute(temperatureTag, "data-temp");
  const feelsLikeRaw = attribute(temperatureTag, "data-feels-like");
  const dewPointRaw = attribute(humidityTag, "data-dew-point");
  const windRaw = attribute(windTag, "data-wind-speed");
  const gustRaw = attribute(windTag, "data-wind-gust");
  const pressureRaw = attribute(pressureTag, "data-pressure");
  const rainRateRaw = attribute(rainTag, "data-precip-rate");
  const rainTodayRaw = attribute(rainTag, "data-precip-total");

  const temperature = imperial
    ? fahrenheitToCelsius(temperatureRaw)
    : bounded(temperatureRaw, -60, 60);
  const humidity = bounded(attribute(humidityTag, "data-humidity"), 0, 100);
  const windDirection = bounded(attribute(windTag, "data-wind-dir"), 0, 360);
  const connected = String(attribute(statusTag, "data-status") || "")
    .toLowerCase() === "connected";

  const elevationMatch = html.match(
    /class=["']elevation-coordinates["'][^>]*>[\s\S]*?<strong>(-?[\d.,]+)<\/strong>\s*(ft|m)\b/i
  );
  let altitude = elevationMatch ? numeric(elevationMatch[1]) : null;
  if (altitude !== null && String(elevationMatch?.[2]).toLowerCase() === "ft") {
    altitude = Math.round(altitude * 0.3048);
  }

  const sourceNameMatch = html.match(
    /<span>\s*Name:\s*<\/span>\s*<span>([\s\S]*?)<\/span>/i
  );
  const sourceName = sourceNameMatch
    ? decodeHtml(sourceNameMatch[1])
    : definition.fullName;

  const station = finalizeStation(definition, {
    sourceName: `${sourceName} - ${definition.upstreamId}`,
    latitude: bounded(attribute(mapTag, "data-latitude"), -90, 90),
    longitude: bounded(attribute(mapTag, "data-longitude"), -180, 180),
    altitude: bounded(altitude, 0, 5000),
    coordinatesApproximate: false,
    temperature,
    temperatureMin: null,
    temperatureMax: null,
    humidity,
    dewPoint: imperial
      ? fahrenheitToCelsius(dewPointRaw)
      : bounded(dewPointRaw, -80, 60),
    windChill: imperial
      ? fahrenheitToCelsius(feelsLikeRaw)
      : bounded(feelsLikeRaw, -80, 60),
    heatIndex: null,
    pressure: imperial
      ? inchesMercuryToHpa(pressureRaw)
      : bounded(pressureRaw, 700, 1150),
    wind: imperial ? milesToKilometres(windRaw) : bounded(windRaw, 0, 300),
    windGust: imperial ? milesToKilometres(gustRaw) : bounded(gustRaw, 0, 350),
    windDirection,
    windDirectionText: directionFromDegrees(windDirection),
    rainRate: imperial
      ? inchesToMillimetres(rainRateRaw)
      : bounded(rainRateRaw, 0, 1000),
    rainHour: null,
    rainToday: imperial
      ? inchesToMillimetres(rainTodayRaw)
      : bounded(rainTodayRaw, 0, 2000),
    solarRadiation: bounded(attribute(solarTag, "data-solar-radiation"), 0, 2000),
    uvIndex: bounded(attribute(uvTag, "data-uv"), 0, 30),
    updatedAt: attribute(statusTag, "data-obs-time-utc"),
    connected,
    modules: {
      temperature: temperatureRaw !== null,
      humidity: attribute(humidityTag, "data-humidity") !== null,
      pressure: pressureRaw !== null,
      rain: rainTodayRaw !== null || rainRateRaw !== null,
      wind: windRaw !== null,
      solar: attribute(solarTag, "data-solar-radiation") !== null,
      uv: attribute(uvTag, "data-uv") !== null
    },
    warnings: []
  });

  if (station.temperature === null && station.humidity === null && station.pressure === null) {
    return parseWundergroundAppState(definition, html);
  }
  return station;
}

async function fetchWundergroundStation(definition) {
  const { text } = await fetchWithTimeout(definition.sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MoenaLive/1.0; +https://andreavio00.github.io/meteo-fassa/)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "it-IT,it;q=0.9,en;q=0.7"
    }
  });
  return parseWunderground(definition, text);
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

function findOutdoorId(station) {
  const typed = findModuleId(station?.module_types, "NAModule1");
  if (typed) return typed;
  return Object.entries(station?.measures || {}).find(([, measure]) =>
    Array.isArray(measure?.type) && measure.type.includes("temperature")
  )?.[0] || null;
}

function safeMoenaAltitude(value) {
  return bounded(value, 900, 2500);
}

async function fetchNetatmoDataset() {
  const tokenPayload = await fetchJson(NETATMO_TOKEN_URL, {
    headers: { "Accept": "application/json" }
  });
  const token = tokenPayload?.body;
  if (!token || typeof token !== "string") {
    throw new Error("Netatmo non ha restituito il token pubblico");
  }

  const params = new URLSearchParams({
    zoom: "13",
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
  if (payload?.error) throw new Error(payload.error.message || "Errore Netatmo");
  return Array.isArray(payload?.body) ? payload.body : [];
}

function normalizeNetatmoStation(definition, rawStations) {
  const station = rawStations.find(item =>
    String(item?._id || "").toLowerCase() === definition.upstreamId.toLowerCase()
  );
  if (!station) throw new Error(`Stazione Netatmo ${definition.upstreamId} non trovata`);

  const place = station.place || {};
  const measures = station.measures || {};
  const moduleTypes = station.module_types || {};
  const outdoorId = findOutdoorId(station);
  const windId = findModuleId(moduleTypes, "NAModule2");
  const rainId = findModuleId(moduleTypes, "NAModule3");
  const outdoor = latestValues(outdoorId ? measures[outdoorId] : null);
  const main = latestValues(measures[station._id]);
  const wind = windId ? measures[windId] || null : null;
  const rain = rainId ? measures[rainId] || null : null;

  const temperature = bounded(outdoor.values.temperature, -60, 60);
  const humidity = bounded(outdoor.values.humidity, 0, 100);
  const pressure = bounded(main.values.pressure, 700, 1150);
  const epochs = [
    outdoor.epoch,
    main.epoch,
    numeric(wind?.wind_timeutc),
    numeric(rain?.rain_timeutc)
  ].filter(value => value !== null);
  const updatedAt = epochs.length ? Math.max(...epochs) * 1000 : null;
  const coordinates = Array.isArray(place.location) ? place.location : [];
  const sourceAltitude = numeric(place.altitude);
  const altitude = safeMoenaAltitude(sourceAltitude);

  const normalized = finalizeStation(definition, {
    sourceName: definition.sourceName,
    latitude: bounded(coordinates[1], -90, 90),
    longitude: bounded(coordinates[0], -180, 180),
    altitude,
    coordinatesApproximate: false,
    temperature,
    temperatureMin: null,
    temperatureMax: null,
    humidity,
    dewPoint: calculateDewPoint(temperature, humidity),
    windChill: null,
    heatIndex: null,
    pressure,
    wind: bounded(wind?.wind_strength, 0, 300),
    windGust: bounded(wind?.gust_strength, 0, 350),
    windDirection: bounded(wind?.wind_angle, 0, 360),
    windDirectionText: directionFromDegrees(wind?.wind_angle),
    rainRate: bounded(rain?.rain_live, 0, 1000),
    rainHour: bounded(rain?.rain_60min, 0, 2000),
    rainToday: bounded(rain?.rain_24h, 0, 2000),
    solarRadiation: null,
    uvIndex: null,
    updatedAt,
    connected: true,
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
      ? [`Quota Netatmo non utilizzata (${sourceAltitude} m non compatibili con Moena).`]
      : []
  });

  if (normalized.temperature === null && normalized.humidity === null && normalized.pressure === null) {
    throw new Error(`Netatmo non ha restituito i dati principali per ${definition.name}`);
  }
  return normalized;
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

async function refreshSnapshot(previous = null) {
  const results = await Promise.allSettled([
    ...WUNDERGROUND_STATIONS.map(fetchWundergroundStation),
    fetchNetatmoDataset()
  ]);
  const previousById = new Map(
    (Array.isArray(previous?.stations) ? previous.stations : [])
      .map(station => [station.id, station])
  );
  const currentById = new Map();
  const errorsById = new Map();

  WUNDERGROUND_STATIONS.forEach((definition, index) => {
    const result = results[index];
    if (result.status === "fulfilled") currentById.set(definition.id, result.value);
    else errorsById.set(definition.id, result.reason);
  });

  const netatmoResult = results[WUNDERGROUND_STATIONS.length];
  if (netatmoResult.status === "fulfilled") {
    for (const definition of NETATMO_STATIONS) {
      try {
        currentById.set(
          definition.id,
          normalizeNetatmoStation(definition, netatmoResult.value)
        );
      } catch (error) {
        errorsById.set(definition.id, error);
      }
    }
  } else {
    for (const definition of NETATMO_STATIONS) {
      errorsById.set(definition.id, netatmoResult.reason);
    }
  }

  const stations = STATION_DEFINITIONS.map(definition => {
    if (currentById.has(definition.id)) return currentById.get(definition.id);
    const previousStation = previousById.get(definition.id);
    return previousStation
      ? staleStation(previousStation, errorsById.get(definition.id))
      : offlineStation(definition, errorsById.get(definition.id));
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

async function getSnapshot(request, context) {
  const cache = globalThis.caches?.default || null;
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(
    `${requestUrl.origin}/__cache/meteomoena-amatoriali-v1`,
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
    stations: STATION_DEFINITIONS.map(publicDefinition),
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
