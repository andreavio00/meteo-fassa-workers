// ======================================================
// GITE METEO AGGREGATOR
// Versione 1.4
//
// Service Bindings richiesti:
// FASSA    -> gitemeteofassa
// TRENTINO -> gite-meteotrentino
// PREDAZZO -> gite-meteopredazzo-rodella
//
// /                   tutte le stazioni e le zone
// /status             controllo rapido di fonti e stazioni
// /zone/{id}          stazioni di una zona
// ?stations           elenco sintetico
// ======================================================


const SCHEMA_VERSION = "1.4";
const TIMEZONE = "Europe/Rome";
const CACHE_TTL_SECONDS = 120;
const UPSTREAM_TIMEOUT_MS = 15_000;
const STALE_AFTER_SECONDS = 30 * 60;

const SAN_PELLEGRINO_WEATHERCLOUD_ID = "6354731265";
const SAN_PELLEGRINO_STATION_URL =
  `https://app.weathercloud.net/d${SAN_PELLEGRINO_WEATHERCLOUD_ID}`;
const SAN_PELLEGRINO_VALUES_URL =
  `https://app.weathercloud.net/device/values/${SAN_PELLEGRINO_WEATHERCLOUD_ID}`;


/*
  Pagine pubbliche delle fonti, pensate per il collegamento dalla UI.
  Non sono necessariamente gli endpoint tecnici usati dai Worker.
*/
const METEOTRENTINO_SOURCE_URL =
  "https://www.meteotrentino.it/dati/meteo/ultimi-dati-meteo/";

const STATION_SOURCE_URLS = {
  "fassa:gardeccia":
    "https://www.meteosystem.com/wlip/gardeccia/dati.php",
  "fassa:principe":
    "https://www.dolomitesmeteo.it/rosengartenpassoprincipe/",
  "fassa:sasspordoi":
    "https://www.dolomitesmeteo.it/sasspordoi/",
  "fassa:rolle":
    "https://www.primierometeo.it/passorolle/",
  "fassa:paradiso":
    "https://www.primierometeo.it/paradiso/",
  "fassa:sarcine":
    SAN_PELLEGRINO_STATION_URL,
  "fassa:passosella":
    "https://www.dolomitesmeteo.it/passosella/tabella.html",
  "fassa:pizboe":
    "https://www.dolomitesmeteo.it/pizboe/",
  "fassa:coldeirossi":
    "https://www.dolomitesmeteo.it/coldeirossi/tabella.php",

  "trentino:moena": METEOTRENTINO_SOURCE_URL,
  "trentino:gries": METEOTRENTINO_SOURCE_URL,
  "trentino:costalunga": METEOTRENTINO_SOURCE_URL,
  "trentino:campitello": METEOTRENTINO_SOURCE_URL,
  "trentino:fedaia": METEOTRENTINO_SOURCE_URL,
  "trentino:ciampac": METEOTRENTINO_SOURCE_URL,
  "trentino:sasdelmul": METEOTRENTINO_SOURCE_URL,

  "predazzo:colrodella":
    "https://icarusfassa.it/stazione-meteo-icarus-flying-team/",
  "predazzo:gardone":
    "https://www.meteo-predazzo.it/gardone-1650-m-slm/",
  "predazzo:passofeudo":
    "https://www.meteo-predazzo.it/passo-feudo-2200-m-slm/",
  "predazzo:torredipisa":
    "https://www.meteo-predazzo.it/rifugio-torre-di-pisa-2671-m-slm/"
};


/*
  Le associazioni geografiche vivono nell'aggregatore centrale.
  I Worker sorgente continuano a occuparsi soltanto della raccolta dati.

  L'ordine delle chiavi e' anche l'ordine di presentazione consigliato.
  Una stazione puo' appartenere a piu' zone.
*/
const ZONES = [
  {
    id: "catinaccio",
    name: "Catinaccio",
    stationKeys: [
      "fassa:gardeccia",
      "fassa:principe",
      "trentino:costalunga",
      "trentino:campitello"
    ]
  },
  {
    id: "sassolungo_sella",
    name: "Sella e Sassolungo",
    stationKeys: [
      "fassa:passosella",
      "fassa:sasspordoi",
      "fassa:pizboe",
      "fassa:coldeirossi",
      "predazzo:colrodella"
    ]
  },
  {
    id: "marmolada_val_s_nicolo",
    name: "Marmolada e Val San Nicolò",
    stationKeys: [
      "trentino:sasdelmul",
      "trentino:ciampac",
      "trentino:fedaia",
      "fassa:coldeirossi"
    ]
  },
  {
    id: "moena_latemar",
    name: "Moena e Latemar",
    stationKeys: [
      "fassa:sarcine",
      "fassa:rolle",
      "predazzo:torredipisa",
      "predazzo:passofeudo",
      "predazzo:gardone"
    ]
  }
];


const ZONE_ALIASES = {
  sella: "sassolungo_sella",
  sella_sassolungo: "sassolungo_sella",
  marmolada: "marmolada_val_s_nicolo",
  moena: "moena_latemar"
};


const STATION_ZONES = new Map();

for (const zone of ZONES) {
  for (const key of zone.stationKeys) {
    const zoneIds = STATION_ZONES.get(key) || [];
    zoneIds.push(zone.id);
    STATION_ZONES.set(key, zoneIds);
  }
}


// ======================================================
// HEADERS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        ...corsHeaders()
      }
    }
  );
}


// ======================================================
// NUMERI
// ======================================================

function num(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  )
    return null;

  if (typeof value === "number")
    return value;

  const cleaned =
    String(value)
      .replace(" m", "")
      .replace(",", ".")
      .trim();

  const n = Number(cleaned);

  return Number.isFinite(n)
    ? n
    : null;
}


// ======================================================
// DIREZIONE VENTO
// ======================================================

function directionFromDegrees(value) {

  const deg = num(value);

  if (deg === null)
    return null;

  const dirs = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW"
  ];

  const normalized =
    ((deg % 360) + 360) % 360;

  return dirs[
    Math.round(normalized / 22.5) % 16
  ];
}


// ======================================================
// NORMALIZZAZIONE
// ======================================================

function normalize(station, family) {

  const s = station || {};
  const stationKey = `${family}:${s.id}`;
  const zones = [
    ...(STATION_ZONES.get(stationKey) || [])
  ];


  // --------------------------
  // VENTO
  // --------------------------

  let wind =
    num(s.wind);

  let windGust =
    num(
      s.windGust ??
      s.gust
    );

  let windMax =
    num(s.windMax);


  /*
    MeteoTrentino restituisce vento in m/s.

    Fassa e Predazzo/Rodella
    vengono mantenuti in km/h.
  */

  if (family === "trentino") {

    if (wind !== null)
      wind =
        +(wind * 3.6)
          .toFixed(1);

    if (windGust !== null)
      windGust =
        +(windGust * 3.6)
          .toFixed(1);

    if (windMax !== null)
      windMax =
        +(windMax * 3.6)
          .toFixed(1);
  }


  const windDegrees =
    num(
      s.windDirectionDegrees
    );


  // --------------------------
  // TEMPERATURA
  // --------------------------

  const temperatureMin =
    num(
      s.temperatureMin ??
      s.temperatureLow
    );

  const temperatureMax =
    num(
      s.temperatureMax ??
      s.temperatureHigh
    );


  // --------------------------
  // RISPOSTA COMUNE
  // --------------------------

  return {

    // Identificazione

    id:
      s.id || null,

    key:
      stationKey,

    name:
      s.name || s.id || null,

    zones,

    primary_zone:
      zones[0] || null,

    altitude:
      num(s.altitude),

    latitude:
      num(s.latitude),

    longitude:
      num(s.longitude),

    family,

    source:
      s.source || family,

    sourceUrl:
      s.sourceUrl ||
      s.url ||
      STATION_SOURCE_URLS[stationKey] ||
      null,

    status:
      s.status || "unknown",


    // --------------------------
    // AGGIORNAMENTO
    // --------------------------

    updated:
      s.updated || null,

    updatedText:
      s.updatedText || null,

    fetchedAt:
      s.fetchedAt || null,


    // --------------------------
    // TEMPERATURA
    // --------------------------

    temperature:
      num(s.temperature),

    temperatureAt:
      s.temperatureAt || null,

    temperatureMin,

    temperatureMinAt:
      s.temperatureMinAt || null,

    temperatureMax,

    temperatureMaxAt:
      s.temperatureMaxAt || null,

    temperatureLowTime:
      s.temperatureLowTime || null,

    temperatureHighTime:
      s.temperatureHighTime || null,


    // --------------------------
    // PERCEPITA
    // --------------------------

    feelsLike:
      num(
        s.feelsLike ??
        s.perceived
      ),

    heatIndex:
      num(s.heatIndex),

    windChill:
      num(s.windChill),

    dewPoint:
      num(s.dewPoint),


    // --------------------------
    // UMIDITÀ
    // --------------------------

    humidity:
      num(s.humidity),

    humidityAt:
      s.humidityAt || null,

    humidityLow:
      num(s.humidityLow),

    humidityHigh:
      num(s.humidityHigh),


    // --------------------------
    // PRESSIONE
    // --------------------------

    pressure:
      num(s.pressure),

    pressureAt:
      s.pressureAt || null,

    pressureLow:
      num(s.pressureLow),

    pressureHigh:
      num(s.pressureHigh),


    // --------------------------
    // VENTO
    // sempre km/h
    // --------------------------

    wind,

    windAt:
      s.windAt || null,

    windGust,

    windGustAt:
      s.windGustAt || null,

    windMax,

    windDirection:
      s.windDirection ||
      directionFromDegrees(
        windDegrees
      ),

    windDirectionDegrees:
      windDegrees,

    windDirectionAt:
      s.windDirectionAt || null,


    // --------------------------
    // PIOGGIA
    // --------------------------

    precipitation:
      num(s.precipitation),

    precipitationAt:
      s.precipitationAt || null,

    rainRate:
      num(s.rainRate),

    rainToday:
      num(s.rainToday),

    rainMonth:
      num(s.rainMonth),

    rainTotal:
      num(s.rainTotal),


    // --------------------------
    // ALTRI SENSORI
    // --------------------------

    solarRadiation:
      num(s.solarRadiation),

    solarRadiationAt:
      s.solarRadiationAt || null,

    snowHeight:
      num(s.snowHeight),

    snowHeightAt:
      s.snowHeightAt || null,

    uv:
      num(s.uv),


    // --------------------------
    // UNITÀ NORMALIZZATE
    // --------------------------

    units: {
      temperature: "°C",
      feelsLike: "°C",
      dewPoint: "°C",
      humidity: "%",
      pressure: "hPa",
      wind: "km/h",
      windGust: "km/h",
      windMax: "km/h",
      windDirectionDegrees: "°",
      precipitation: "mm",
      rain: "mm",
      rainRate: "mm/h",
      solarRadiation: "W/m²",
      snowHeight: "cm",
      uv: "index"
    },


    // --------------------------
    // DATI ORIGINALI
    // --------------------------

    original: s
  };
}


// ======================================================
// PASSO SAN PELLEGRINO - WEATHERCLOUD SARCINE
// ======================================================

/*
  La stazione WeatherCloud di Sarcine si trova nel settore del Passo San
  Pellegrino e trasmette temperatura, umidita', vento, pressione e pioggia.
  La leggiamo in parallelo ai tre Worker sorgente: in questo modo Cima
  Paradiso (che appartiene al Passo Rolle) non viene usata come riferimento
  geografico del San Pellegrino.

  L'epoch della fonte viene sempre controllato: oltre 30 minuti i valori sono
  marcati come "stale" e il frontend non li presenta come osservazioni
  correnti. Non combiniamo i dati con quelli di altre stazioni vicine.
*/

function weatherCloudWindKmh(value) {
  const speed = num(value);
  return speed === null
    ? null
    : Math.round(speed * 36) / 10;
}


function weatherCloudUpdated(epoch) {
  const seconds = num(epoch);

  if (seconds === null || seconds <= 0)
    return null;

  const milliseconds = seconds > 1_000_000_000_000
    ? seconds
    : seconds * 1000;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}


function parseSanPellegrinoStation(values) {
  const fetchedAt = new Date().toISOString();
  const updated = weatherCloudUpdated(values?.epoch);
  const updatedTime = updated ? Date.parse(updated) : null;
  const ageSeconds = updatedTime === null
    ? null
    : Math.max(0, Math.round((Date.now() - updatedTime) / 1000));
  const temperature = num(values?.temp);
  const humidity = num(values?.hum);
  const pressure = num(values?.bar);
  const hasCoreData =
    temperature !== null ||
    humidity !== null ||
    pressure !== null;

  let status = "offline";
  if (hasCoreData && ageSeconds !== null) {
    status = ageSeconds <= STALE_AFTER_SECONDS
      ? "online"
      : "stale";
  }

  return {
    id: "sarcine",
    name: "Sarcine · Passo San Pellegrino",
    altitude: 1800,
    latitude: 46.3758124,
    longitude: 11.7500821,
    source: "WeatherCloud",
    sourceUrl: SAN_PELLEGRINO_STATION_URL,
    status,
    updated,
    fetchedAt,
    temperature,
    humidity,
    pressure,
    precipitation: num(values?.rain),
    rainToday: num(values?.rain),
    rainRate: num(values?.rainrate),
    wind: weatherCloudWindKmh(values?.wspdavg ?? values?.wspd),
    windGust: weatherCloudWindKmh(values?.wspdhi),
    windDirectionDegrees: num(values?.wdiravg ?? values?.wdir),
    dewPoint: num(values?.dew),
    windChill: num(values?.chill),
    heatIndex: num(values?.heat),
    weatherCloudId: SAN_PELLEGRINO_WEATHERCLOUD_ID,
    ageSeconds
  };
}


function unavailableSanPellegrinoStation(error) {
  return {
    id: "sarcine",
    name: "Sarcine · Passo San Pellegrino",
    altitude: 1800,
    latitude: 46.3758124,
    longitude: 11.7500821,
    source: "WeatherCloud",
    sourceUrl: SAN_PELLEGRINO_STATION_URL,
    status: "error",
    updated: null,
    fetchedAt: new Date().toISOString(),
    weatherCloudId: SAN_PELLEGRINO_WEATHERCLOUD_ID,
    error: String(error?.message || error || "Fonte non disponibile")
  };
}


async function fetchSanPellegrinoStation() {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      SAN_PELLEGRINO_VALUES_URL,
      {
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Referer": SAN_PELLEGRINO_STATION_URL,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (compatible; MeteoFassaWorker/1.4)"
        },
        signal: controller.signal,
        cf: {
          cacheEverything: true,
          cacheTtl: CACHE_TTL_SECONDS
        }
      }
    );

    if (!response.ok)
      throw new Error(`WeatherCloud HTTP ${response.status}`);

    const text = await response.text();
    if (!text)
      throw new Error("WeatherCloud ha restituito una risposta vuota");

    let values;
    try {
      values = JSON.parse(text);
    } catch {
      throw new Error("WeatherCloud ha restituito un JSON non valido");
    }

    return parseSanPellegrinoStation(values);
  } catch (error) {
    return unavailableSanPellegrinoStation(error);
  } finally {
    clearTimeout(timer);
  }
}


// ======================================================
// LETTURA SERVICE BINDING
// ======================================================

async function fetchService(
  id,
  binding
) {

  try {

    const response =
      await binding.fetch(
        new Request(
          "https://internal/"
        )
      );


    if (!response.ok)
      throw new Error(
        `HTTP ${response.status}`
      );


    const data =
      await response.json();


    const stations =
      Array.isArray(
        data?.stations
      )
        ? data.stations
        : [];


    return {

      id,

      status:
        "online",

      version:
        data.version || null,

      generatedAt:
        data.generatedAt || null,

      count:
        stations.length,

      stations
    };


  } catch (err) {

    return {

      id,

      status:
        "error",

      version:
        null,

      generatedAt:
        null,

      count:
        0,

      stations:
        [],

      error:
        String(
          err?.message ||
          err
        )
    };
  }
}


// ======================================================
// ZONE E RIEPILOGO
// ======================================================

function stationSummary(station) {
  return {
    id: station.id,
    key: station.key,
    name: station.name,
    altitude: station.altitude,
    family: station.family,
    source: station.source,
    sourceUrl: station.sourceUrl,
    status: station.status,
    zones: station.zones,
    primary_zone: station.primary_zone,
    updated: station.updated,
    updatedText: station.updatedText,
    fetchedAt: station.fetchedAt
  };
}


function buildZone(zone, stations) {
  const stationByKey = new Map(
    stations.map(station => [station.key, station])
  );

  const zoneStations = zone.stationKeys
    .map(key => stationByKey.get(key))
    .filter(Boolean);

  const missingStationKeys = zone.stationKeys
    .filter(key => !stationByKey.has(key));

  return {
    id: zone.id,
    name: zone.name,
    expected_station_count: zone.stationKeys.length,
    station_count: zoneStations.length,
    missing_station_keys: missingStationKeys,
    stations: zoneStations
  };
}


function buildZones(stations) {
  return ZONES.map(zone => buildZone(zone, stations));
}


function resolveZone(rawId) {
  let requestedId;

  try {
    requestedId = decodeURIComponent(
      String(rawId || "")
    ).toLowerCase();
  } catch {
    return null;
  }

  const zoneId = ZONE_ALIASES[requestedId] || requestedId;
  return ZONES.find(zone => zone.id === zoneId) || null;
}


function buildOverview(stations, results) {
  const onlineStations = stations.filter(
    station => station.status === "online"
  ).length;

  const families = {};

  for (const result of results) {
    const familyStations = stations.filter(
      station => station.family === result.id
    );

    families[result.id] = {
      total: familyStations.length,
      online: familyStations.filter(
        station => station.status === "online"
      ).length,
      offline: familyStations.filter(
        station => station.status !== "online"
      ).length,
      source_status: result.status
    };
  }

  return {
    total_stations: stations.length,
    online_stations: onlineStations,
    offline_stations: stations.length - onlineStations,
    all_online:
      results.every(result => result.status === "online") &&
      onlineStations === stations.length,
    families,
    unassigned_stations: stations
      .filter(station => station.zones.length === 0)
      .map(stationSummary),
    stations: stations.map(stationSummary)
  };
}


// ======================================================
// WORKER
// ======================================================

export default {

  async fetch(request, env) {


    // --------------------------
    // CORS
    // --------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders()
        }
      );
    }


    const url =
      new URL(request.url);

    const pathname =
      url.pathname.replace(/\/+$/, "") || "/";


    if (request.method !== "GET") {
      return json(
        {
          error: "Metodo non consentito"
        },
        405
      );
    }


    // ==================================================
    // CARICA LE TRE FAMIGLIE IN PARALLELO
    // ==================================================

    const [results, sanPellegrinoStation] =
      await Promise.all([

        Promise.all([

          fetchService(
            "fassa",
            env.FASSA
          ),

          fetchService(
            "trentino",
            env.TRENTINO
          ),

          fetchService(
            "predazzo",
            env.PREDAZZO
          )

        ]),

        fetchSanPellegrinoStation()

      ]);


    const fassaResult =
      results.find(result => result.id === "fassa");

    if (
      fassaResult &&
      !fassaResult.stations.some(station => station?.id === "sarcine")
    ) {
      fassaResult.stations.push(sanPellegrinoStation);
      fassaResult.count = fassaResult.stations.length;
    }


    // ==================================================
    // NORMALIZZA
    // ==================================================

    const stations = [];


    for (
      const result
      of results
    ) {

      for (
        const station
        of result.stations
      ) {

        stations.push(
          normalize(
            station,
            result.id
          )
        );
      }
    }


    const generatedAt =
      new Date().toISOString();

    const sources =
      results.map(
        result => ({
          id: result.id,
          status: result.status,
          version: result.version,
          generated_at: result.generatedAt,
          generatedAt: result.generatedAt,
          count: result.count,
          error: result.error || null
        })
      );

    const zones =
      buildZones(stations);

    const overview =
      buildOverview(stations, results);


    // ==================================================
    // /status
    // ==================================================

    if (pathname === "/status") {
      return json({
        schema_version: SCHEMA_VERSION,
        generated_at: generatedAt,
        timezone: TIMEZONE,
        overview,
        sources
      });
    }


    // ==================================================
    // /zone/{id}
    // ==================================================

    const zoneMatch =
      pathname.match(/^\/zone\/([^/]+)$/);

    if (zoneMatch) {
      const zone = resolveZone(zoneMatch[1]);

      if (!zone) {
        return json(
          {
            schema_version: SCHEMA_VERSION,
            generated_at: generatedAt,
            error: "Zona non trovata",
            available_zones: ZONES.map(item => item.id)
          },
          404
        );
      }

      return json({
        schema_version: SCHEMA_VERSION,
        generated_at: generatedAt,
        timezone: TIMEZONE,
        zone: buildZone(zone, stations)
      });
    }


    // ==================================================
    // ?stations
    // VERSIONE LEGGERA
    // ==================================================

    if (
      pathname === "/stations" ||
      url.searchParams.has("stations")
    ) {

      return json({

        schema_version:
          SCHEMA_VERSION,

        generated_at:
          generatedAt,

        timezone:
          TIMEZONE,

        version:
          SCHEMA_VERSION,

        generatedAt:
          generatedAt,

        count:
          stations.length,

        stations:
          stations.map(stationSummary)
      });
    }


    // ==================================================
    // RISPOSTA COMPLETA
    // ==================================================

    return json({

      schema_version:
        SCHEMA_VERSION,

      generated_at:
        generatedAt,

      timezone:
        TIMEZONE,

      cache_ttl_seconds:
        CACHE_TTL_SECONDS,

      overview,

      total_unique_stations:
        stations.length,

      total_zones:
        zones.length,

      zones,

      version:
        SCHEMA_VERSION,

      generatedAt:
        generatedAt,

      count:
        stations.length,


      // Stato dei tre Worker sorgente

      sources:
        sources,


      // Tutte le stazioni

      stations
    });
  }
};
